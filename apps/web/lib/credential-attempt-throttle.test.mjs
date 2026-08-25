import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_ATTEMPT_TABLE,
  CredentialAttemptThrottleUnavailableError,
  EMAIL_GLOBAL_ATTEMPT_LIMIT,
  EMAIL_NETWORK_ATTEMPT_LIMIT,
  cleanupExpiredCredentialAttemptWindows,
  clientNetworkForAddress,
  clientNetworkFromHeaders,
  consumeCredentialAttempt,
  credentialAttemptBucket,
  fixedCredentialAttemptWindow,
  normalizeCredentialEmail,
} from "./credential-attempt-throttle.ts";

const secret = "test-secret-with-at-least-thirty-two-bytes-123456789";
const now = Date.parse("2026-08-25T10:07:31.000Z");

function headers(values) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => normalized.get(name.toLowerCase()) ?? null };
}

function creatingDb() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    createRow: async (input) => {
      calls.push(["create", input]);
      if (rows.has(input.rowId)) throw { code: 409 };
      const row = { $id: input.rowId, ...input.data };
      rows.set(input.rowId, row);
      return row;
    },
    incrementRowColumn: async (input) => {
      calls.push(["increment", input]);
      const row = rows.get(input.rowId);
      if (!row) throw { code: 404 };
      row[input.column] += input.value;
      return row;
    },
    listRows: async () => ({ rows: [] }),
    deleteRow: async () => undefined,
  };
}

test("normalizes email and uses fixed fifteen-minute UTC windows", () => {
  assert.equal(normalizeCredentialEmail("  Admin@Example.COM  "), "admin@example.com");
  assert.deepEqual(fixedCredentialAttemptWindow(now), {
    startedAtMs: Date.parse("2026-08-25T10:00:00.000Z"),
    expiresAtMs: Date.parse("2026-08-25T10:15:00.000Z"),
    startedAt: "2026-08-25T10:00:00.000Z",
    expiresAt: "2026-08-25T10:15:00.000Z",
  });
});

test("canonicalizes IPv4 /24 and IPv6 /64 networks from proxy headers", () => {
  assert.equal(clientNetworkForAddress("203.0.113.77"), "203.0.113.0/24");
  assert.equal(clientNetworkForAddress("2001:0db8:abcd:0012::99"), "2001:db8:abcd:12::/64");
  assert.equal(clientNetworkForAddress("::ffff:203.0.113.77"), "203.0.113.0/24");
  assert.equal(
    clientNetworkFromHeaders(headers({ "x-forwarded-for": "198.51.100.9, 203.0.113.77" })),
    "203.0.113.0/24",
  );
  assert.equal(clientNetworkFromHeaders(headers({})), "unknown");
});

test("HMAC-derived bucket IDs never store raw email or network data", () => {
  const bucket = credentialAttemptBucket({
    email: "Admin@Example.com",
    clientNetwork: "203.0.113.0/24",
    scope: "email_network",
    secret,
    now,
  });
  const serialized = JSON.stringify(bucket);
  assert.match(bucket.rowId, /^atn_[a-f0-9]{32}$/);
  assert.ok(bucket.rowId.length <= 36);
  assert.doesNotMatch(serialized, /admin@example\.com/i);
  assert.doesNotMatch(serialized, /203\.0\.113/);
  assert.deepEqual(Object.keys(bucket.data).sort(), ["attempts", "expires_at", "scope", "window_started_at"]);
  assert.notEqual(
    bucket.rowId,
    credentialAttemptBucket({ email: "Admin@Example.com", clientNetwork: "203.0.113.0/24", scope: "email", secret, now }).rowId,
  );
  assert.notEqual(
    bucket.rowId,
    credentialAttemptBucket({ email: "Admin@Example.com", clientNetwork: "203.0.113.0/24", scope: "email_network", secret, now: now + 15 * 60_000 }).rowId,
  );
  assert.equal(
    bucket.rowId,
    credentialAttemptBucket({ email: " admin@EXAMPLE.COM ", clientNetwork: "203.0.113.0/24", scope: "email_network", secret, now }).rowId,
  );
  assert.notEqual(
    bucket.rowId,
    credentialAttemptBucket({ email: "Admin@Example.com", clientNetwork: "203.0.113.0/24", scope: "email_network", secret: `${secret}-rotated`, now }).rowId,
  );
});

test("atomically creates then increments global and network buckets", async () => {
  const db = creatingDb();
  const input = {
    db,
    databaseId: "fieldops",
    email: "admin@example.com",
    clientAddress: "203.0.113.77",
    secret,
    now,
    cleanup: "never",
  };

  const first = await consumeCredentialAttempt(input);
  const second = await consumeCredentialAttempt(input);
  assert.equal(first.allowed, true);
  assert.equal(second.emailAttempts, 2);
  assert.equal(second.emailNetworkAttempts, 2);
  assert.equal(db.rows.size, 2);
  assert.equal(db.calls.filter(([kind]) => kind === "increment").length, 2);
  assert.ok(db.calls.filter(([kind]) => kind === "create").every(([, call]) => call.tableId === CREDENTIAL_ATTEMPT_TABLE));
  assert.ok(db.calls.filter(([kind]) => kind === "create").every(([, call]) => call.permissions.length === 0));
});

test("blocks the seventh same-network attempt while preserving the higher email cap", async () => {
  const db = creatingDb();
  let result;
  for (let attempt = 1; attempt <= EMAIL_NETWORK_ATTEMPT_LIMIT + 1; attempt += 1) {
    result = await consumeCredentialAttempt({
      db,
      databaseId: "fieldops",
      email: "admin@example.com",
      clientAddress: "203.0.113.77",
      secret,
      now,
      cleanup: "never",
    });
  }
  assert.equal(result.allowed, false);
  assert.equal(result.blockedBy, "email_network");
  assert.equal(result.emailAttempts, EMAIL_NETWORK_ATTEMPT_LIMIT + 1);
  assert.equal(result.retryAfterSeconds, 449);
});

test("global email limit blocks distributed/spoofed networks before another network bucket is created", async () => {
  const db = creatingDb();
  let result;
  for (let attempt = 1; attempt <= EMAIL_GLOBAL_ATTEMPT_LIMIT + 1; attempt += 1) {
    result = await consumeCredentialAttempt({
      db,
      databaseId: "fieldops",
      email: "target@example.com",
      clientAddress: `203.0.${attempt}.7`,
      secret,
      now,
      cleanup: "never",
    });
  }
  assert.equal(result.allowed, false);
  assert.equal(result.blockedBy, "email");
  assert.equal(result.emailNetworkAttempts, null);
  assert.equal(db.rows.size, EMAIL_GLOBAL_ATTEMPT_LIMIT + 1);
});

test("fails closed when durable counter storage is unavailable or invalid", async () => {
  const unavailableDb = {
    createRow: async () => { throw { code: 503 }; },
    incrementRowColumn: async () => { throw new Error("should not run"); },
    listRows: async () => ({ rows: [] }),
    deleteRow: async () => undefined,
  };
  await assert.rejects(
    consumeCredentialAttempt({
      db: unavailableDb,
      databaseId: "fieldops",
      email: "admin@example.com",
      clientAddress: "203.0.113.1",
      secret,
      now,
    }),
    CredentialAttemptThrottleUnavailableError,
  );
  await assert.rejects(
    consumeCredentialAttempt({
      db: unavailableDb,
      databaseId: "fieldops",
      email: "admin@example.com",
      clientAddress: "203.0.113.1",
      secret: "too-short",
      now,
    }),
    CredentialAttemptThrottleUnavailableError,
  );
});

test("cleanup is bounded and tolerates rows already removed by another instance", async () => {
  const deleted = [];
  const db = {
    listRows: async (input) => {
      assert.equal(input.total, false);
      assert.ok(input.queries.some((query) => query.includes("limit")));
      return { rows: [{ $id: "old_1" }, { $id: "old_2" }] };
    },
    deleteRow: async ({ rowId }) => {
      deleted.push(rowId);
      if (rowId === "old_2") throw { code: 404 };
    },
  };
  assert.equal(await cleanupExpiredCredentialAttemptWindows(db, "fieldops", now), 1);
  assert.deepEqual(deleted, ["old_1", "old_2"]);
});
