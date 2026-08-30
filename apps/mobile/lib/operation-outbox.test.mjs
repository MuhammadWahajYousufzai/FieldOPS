import assert from "node:assert/strict";
import test from "node:test";

import {
  appendUniqueOutboxRecord,
  canAttemptOutboxRecord,
  classifyOperationFailure,
  createDurableOutboxController,
  normalizeRestoredOutbox,
  operationIdentity,
  operationRetryDecision,
  resumeAuthFailedOutboxRecords,
  resumeInterruptedOutboxRecords,
  selectOutboxCandidates,
  summarizeOutbox,
} from "./operation-outbox.ts";

function record(overrides = {}) {
  return {
    id: "queue-1",
    employeeId: "employee-1",
    state: "pending",
    createdAt: "2026-08-25T10:00:00.000Z",
    attempts: 0,
    operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-1" } },
    ...overrides,
  };
}

test("operationIdentity uses visit ID so the same marked-place evidence cannot queue twice", () => {
  const first = { type: "visit_submit", path: "/visits/submit", fields: { visitId: "visit-1", idempotencyKey: "attempt-1" } };
  const replay = { type: "visit_submit", path: "/visits/submit", fields: { visitId: "visit-1", idempotencyKey: "attempt-2" } };
  assert.equal(operationIdentity(first), "visit:visit-1");
  assert.equal(operationIdentity(first), operationIdentity(replay));
});

test("appendUniqueOutboxRecord preserves the first durable idempotent operation", () => {
  const original = record();
  const duplicate = record({ id: "queue-2" });
  const result = appendUniqueOutboxRecord([original], duplicate);
  assert.equal(result.length, 1);
  assert.equal(result[0], original);
});

test("normalizeRestoredOutbox recovers syncing work and removes duplicate replays", () => {
  const restored = normalizeRestoredOutbox([
    record({ id: "old", state: "syncing" }),
    record({ id: "duplicate", state: "failed", attempts: 2 }),
    record({ id: "different", operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-2" } } }),
  ]);
  assert.deepEqual(restored.map((item) => [item.id, item.state]), [
    ["old", "pending"],
    ["different", "pending"],
  ]);
});

test("normalizeRestoredOutbox retains a confirmed copy over an unconfirmed duplicate", () => {
  const restored = normalizeRestoredOutbox([
    record({ id: "pending" }),
    record({ id: "confirmed", state: "confirmed" }),
  ]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, "confirmed");
});

test("failure classification separates authentication, conflicts, validation, server and connection errors", () => {
  assert.equal(classifyOperationFailure(401), "auth");
  assert.equal(classifyOperationFailure(409), "conflict");
  assert.equal(classifyOperationFailure(422), "validation");
  assert.equal(classifyOperationFailure(429), "server");
  assert.equal(classifyOperationFailure(503), "server");
  assert.equal(classifyOperationFailure(0), "connection");
});

test("retry policy uses bounded jitter and respects Retry-After", () => {
  assert.deepEqual(operationRetryDecision({ status: 409, attempts: 1, nowMs: 0 }), {
    errorKind: "conflict",
    retryable: false,
  });
  assert.deepEqual(operationRetryDecision({ status: 503, attempts: 1, nowMs: 0, random: () => 0 }), {
    errorKind: "server",
    retryable: true,
    nextAttemptAt: "1970-01-01T00:00:00.500Z",
  });
  assert.equal(
    operationRetryDecision({ status: 429, attempts: 1, retryAfterMs: 20_000, nowMs: 0, random: () => 0 }).nextAttemptAt,
    "1970-01-01T00:00:20.000Z",
  );
});

test("forced reconnect bypasses backoff but not permanent failures", () => {
  const records = [
    record({ id: "later", state: "failed", retryable: true, nextAttemptAt: "2026-08-25T10:01:00.000Z" }),
    record({ id: "conflict", state: "failed", retryable: false, operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-2" } } }),
    record({ id: "ready", createdAt: "2026-08-25T09:59:00.000Z", operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-3" } } }),
  ];
  assert.deepEqual(
    selectOutboxCandidates(records, "employee-1", { nowMs: new Date("2026-08-25T10:00:30.000Z").valueOf() }).map((item) => item.id),
    ["ready"],
  );
  assert.equal(canAttemptOutboxRecord(records[1], { force: true }), false);
  assert.deepEqual(selectOutboxCandidates(records, "employee-1", { force: true }).map((item) => item.id), ["ready", "later"]);
});

test("summarizeOutbox exposes progress and records that need attention", () => {
  const summary = summarizeOutbox([
    record({ id: "confirmed", state: "confirmed" }),
    record({ id: "syncing", state: "syncing", operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-2" } } }),
    record({ id: "blocked", state: "failed", retryable: false, operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-3" } } }),
  ], "employee-1");
  assert.deepEqual(summary, {
    total: 3,
    confirmed: 1,
    pending: 2,
    syncing: 1,
    failed: 1,
    needsAttention: 1,
    progress: 1 / 3,
  });
});

test("durable controller persists before publishing a queue update", async () => {
  let current = [record()];
  let finishPersist;
  const events = [];
  const persistenceGate = new Promise((resolve) => { finishPersist = resolve; });
  const controller = createDurableOutboxController({
    readCurrent: () => current,
    persist: async () => {
      events.push("persist:start");
      await persistenceGate;
      events.push("persist:done");
    },
    publish: (next) => {
      events.push("publish");
      current = next;
    },
  });

  const update = controller.update((items) => [...items, record({ id: "queue-2", operation: undefined })]);
  await Promise.resolve();
  assert.equal(current.length, 1);
  assert.deepEqual(events, ["persist:start"]);
  finishPersist();
  await update;
  assert.equal(current.length, 2);
  assert.deepEqual(events, ["persist:start", "persist:done", "publish"]);
});

test("durable controller leaves published state unchanged on storage failure and recovers its mutation chain", async () => {
  let current = [record()];
  let writes = 0;
  const controller = createDurableOutboxController({
    readCurrent: () => current,
    persist: async () => {
      writes += 1;
      if (writes === 1) throw new Error("disk full");
    },
    publish: (next) => { current = next; },
  });

  await assert.rejects(
    controller.update((items) => [...items, record({ id: "not-durable", operation: undefined })]),
    /disk full/,
  );
  assert.deepEqual(current.map((item) => item.id), ["queue-1"]);

  await controller.update((items) => [...items, record({ id: "durable", operation: undefined })]);
  assert.deepEqual(current.map((item) => item.id), ["queue-1", "durable"]);
});

test("durable controller serializes concurrent transforms against the latest published queue", async () => {
  let current = [];
  const snapshots = [];
  const controller = createDurableOutboxController({
    readCurrent: () => current,
    persist: async (next) => { snapshots.push(next.map((item) => item.id)); },
    publish: (next) => { current = next; },
  });

  await Promise.all([
    controller.update((items) => [...items, record({ id: "first", operation: undefined })]),
    controller.update((items) => [...items, record({ id: "second", operation: undefined })]),
  ]);
  assert.deepEqual(snapshots, [["first"], ["first", "second"]]);
  assert.deepEqual(current.map((item) => item.id), ["first", "second"]);
});

test("persistCurrent re-saves an equivalent queue and surfaces storage failure", async () => {
  const current = [record()];
  let fail = false;
  let persisted;
  const controller = createDurableOutboxController({
    readCurrent: () => current,
    persist: async (next) => {
      if (fail) throw new Error("storage unavailable");
      persisted = next;
    },
    publish: () => { throw new Error("persistCurrent must not republish"); },
  });

  assert.deepEqual(await controller.persistCurrent(), current);
  assert.deepEqual(persisted, current);
  fail = true;
  await assert.rejects(controller.persistCurrent(), /storage unavailable/);
});

test("normal reconnect selection respects permanent failures and retry backoff", () => {
  const records = [
    record({ id: "auth", state: "failed", retryable: false, errorKind: "auth" }),
    record({ id: "validation", state: "failed", retryable: false, errorKind: "validation", operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-2" } } }),
    record({ id: "backoff", state: "failed", retryable: true, nextAttemptAt: "2026-08-25T10:10:00.000Z", operation: { type: "json", path: "/orders", body: { idempotencyKey: "order-3" } } }),
  ];
  assert.deepEqual(
    selectOutboxCandidates(records, "employee-1", { nowMs: new Date("2026-08-25T10:00:00.000Z").valueOf() }),
    [],
  );
});

test("fresh authentication resumes only that employee's auth-failed work", () => {
  const records = [
    { id: "a", employeeId: "employee-1", state: "failed", error: "Expired", errorKind: "auth", httpStatus: 401, retryable: false, nextAttemptAt: "2026-08-25T12:00:00.000Z" },
    { id: "b", employeeId: "employee-1", state: "failed", errorKind: "validation", retryable: false },
    { id: "c", employeeId: "employee-2", state: "failed", errorKind: "auth", retryable: false },
  ];
  const resumed = resumeAuthFailedOutboxRecords(records, "employee-1");
  assert.deepEqual(resumed[0], {
    id: "a",
    employeeId: "employee-1",
    state: "pending",
    error: undefined,
    errorKind: undefined,
    httpStatus: undefined,
    retryable: undefined,
    nextAttemptAt: undefined,
  });
  assert.equal(resumed[1], records[1]);
  assert.equal(resumed[2], records[2]);
});

test("fresh authentication resumes only that employee's interrupted upload", () => {
  const records = [
    record({ id: "mine", employeeId: "employee-1", state: "syncing" }),
    record({ id: "other", employeeId: "employee-2", state: "syncing" }),
    record({ id: "done", employeeId: "employee-1", state: "confirmed" }),
  ];
  const resumed = resumeInterruptedOutboxRecords(records, "employee-1");
  assert.equal(resumed[0].state, "pending");
  assert.equal(resumed[1], records[1]);
  assert.equal(resumed[2], records[2]);
});
