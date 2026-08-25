import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCATION_STORAGE_CHUNK_SIZE,
  MAX_LOCATION_QUEUE_ITEMS,
  authenticationAttemptWasReplaced,
  canAttemptLocationItem,
  confirmedLocationIds,
  createKeyedSingleFlight,
  createKeyedTrailingSingleFlight,
  createLocationQueueStoragePlan,
  deduplicateLocationItems,
  deterministicLocationKey,
  drainLocationOutbox,
  restoreLocationQueueChunks,
} from "./location-outbox.ts";

function queueHarness(size) {
  let queue = Array.from({ length: size }, (_, index) => ({ idempotencyKey: `point-${index}` }));
  return {
    readPending: async () => [...queue],
    removeConfirmed: async (confirmed) => {
      queue = queue.filter((point) => !confirmed.has(point.idempotencyKey));
    },
    remaining: () => [...queue],
  };
}

test("drainLocationOutbox sends more than one 100-point batch", async () => {
  const queue = queueHarness(250);
  const batchSizes = [];

  const confirmed = await drainLocationOutbox({
    readPending: queue.readPending,
    removeConfirmed: queue.removeConfirmed,
    sendBatch: async (batch) => {
      batchSizes.push(batch.length);
      return { confirmed: batch.map((point) => point.idempotencyKey) };
    },
  });

  assert.equal(confirmed, 250);
  assert.deepEqual(batchSizes, [100, 100, 50]);
  assert.equal(queue.remaining().length, 0);
});

test("drainLocationOutbox stops after five batches", async () => {
  const queue = queueHarness(650);
  let requests = 0;

  const confirmed = await drainLocationOutbox({
    readPending: queue.readPending,
    removeConfirmed: queue.removeConfirmed,
    sendBatch: async (batch) => {
      requests += 1;
      return { confirmed: batch.map((point) => point.idempotencyKey) };
    },
  });

  assert.equal(confirmed, 500);
  assert.equal(requests, 5);
  assert.equal(queue.remaining().length, 150);
});

test("drainLocationOutbox keeps unconfirmed points and continues after partial confirmation", async () => {
  const queue = queueHarness(150);
  let request = 0;

  const confirmed = await drainLocationOutbox({
    readPending: queue.readPending,
    removeConfirmed: queue.removeConfirmed,
    sendBatch: async (batch) => {
      request += 1;
      const accepted = request === 1 ? batch.slice(0, 60) : batch;
      return { confirmed: accepted.map((point) => point.idempotencyKey) };
    },
  });

  assert.equal(confirmed, 150);
  assert.equal(request, 2);
  assert.equal(queue.remaining().length, 0);
});

test("drainLocationOutbox quarantines non-retryable points and continues with later work", async () => {
  let pending = [
    { idempotencyKey: "bad-point" },
    { idempotencyKey: "good-point-1" },
    { idempotencyKey: "good-point-2" },
  ];
  const quarantined = new Set();
  let request = 0;

  const confirmed = await drainLocationOutbox({
    batchSize: 2,
    readPending: async () => pending.filter((point) => !quarantined.has(point.idempotencyKey)),
    removeConfirmed: async (ids) => { pending = pending.filter((point) => !ids.has(point.idempotencyKey)); },
    quarantineRejected: async (items) => { for (const id of items.keys()) quarantined.add(id); },
    sendBatch: async (batch) => {
      request += 1;
      if (request === 1) return {
        confirmed: ["good-point-1"],
        rejected: [{ idempotencyKey: "bad-point", reason: "invalid_point", retryable: false }],
      };
      return { confirmed: batch.map((point) => point.idempotencyKey), rejected: [] };
    },
  });

  assert.equal(confirmed, 2);
  assert.deepEqual([...quarantined], ["bad-point"]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].idempotencyKey, "bad-point");
  assert.equal(request, 2);
});

test("drainLocationOutbox does not delete points for malformed successful payloads", async (t) => {
  const malformedPayloads = [
    { name: "missing confirmed", value: { ok: true } },
    { name: "confirmed is not an array", value: { confirmed: "point-0" } },
    { name: "confirmed contains an unknown ID", value: { confirmed: ["point-0", "not-submitted"] } },
    { name: "confirmed contains a non-string", value: { confirmed: ["point-0", 1] } },
    { name: "an ID is both confirmed and rejected", value: { confirmed: ["point-0"], rejected: [{ idempotencyKey: "point-0", retryable: true }] } },
    { name: "an ID has contradictory rejections", value: { confirmed: [], rejected: [
      { idempotencyKey: "point-0", retryable: true },
      { idempotencyKey: "point-0", retryable: false },
    ] } },
  ];

  for (const malformed of malformedPayloads) {
    await t.test(malformed.name, async () => {
      const queue = queueHarness(3);
      const confirmed = await drainLocationOutbox({
        readPending: queue.readPending,
        removeConfirmed: queue.removeConfirmed,
        sendBatch: async () => malformed.value,
      });

      assert.equal(confirmed, 0);
      assert.equal(queue.remaining().length, 3);
    });
  }
});

test("confirmedLocationIds deduplicates valid confirmations", () => {
  assert.deepEqual(
    [...confirmedLocationIds({ confirmed: ["point-1", "point-1"] }, ["point-1", "point-2"])],
    ["point-1"],
  );
});

test("drainLocationOutbox reports a transport failure without deleting the point", async () => {
  const queue = queueHarness(1);
  let reported = "";
  const confirmed = await drainLocationOutbox({
    readPending: queue.readPending,
    removeConfirmed: queue.removeConfirmed,
    sendBatch: async () => { throw new Error("Location sync returned 401."); },
    onError: async (error) => { reported = error.message; },
  });
  assert.equal(confirmed, 0);
  assert.equal(queue.remaining().length, 1);
  assert.equal(reported, "Location sync returned 401.");
});

test("createKeyedSingleFlight coalesces concurrent work and permits a later run", async () => {
  const flights = createKeyedSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const operation = async () => {
    calls += 1;
    await gate;
    return 7;
  };

  const first = flights.run("employee-1", operation);
  const second = flights.run("employee-1", operation);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);

  assert.equal(await flights.run("employee-1", async () => {
    calls += 1;
    return 8;
  }), 8);
  assert.equal(calls, 2);
});

test("retryable server rejections are retained and pause the current drain", async () => {
  const queue = queueHarness(3);
  let retryable;
  let requests = 0;
  const confirmed = await drainLocationOutbox({
    readPending: queue.readPending,
    removeConfirmed: queue.removeConfirmed,
    sendBatch: async () => {
      requests += 1;
      return {
        confirmed: ["point-0"],
        rejected: [{ idempotencyKey: "point-1", reason: "server_write_failed", retryable: true }],
      };
    },
    onRetryableRejected: async (items) => { retryable = items; },
  });
  assert.equal(confirmed, 1);
  assert.equal(requests, 1);
  assert.deepEqual([...retryable], [["point-1", "server_write_failed"]]);
  assert.deepEqual(queue.remaining().map((point) => point.idempotencyKey), ["point-1", "point-2"]);
});

test("a batch disposition can be persisted atomically", async () => {
  const queue = queueHarness(2);
  let writes = 0;
  await drainLocationOutbox({
    readPending: queue.readPending,
    removeConfirmed: async () => { throw new Error("legacy mutation should not run"); },
    applyDisposition: async (disposition) => {
      writes += 1;
      await queue.removeConfirmed(disposition.confirmed);
    },
    sendBatch: async (batch) => ({ confirmed: batch.map((point) => point.idempotencyKey), rejected: [] }),
  });
  assert.equal(writes, 1);
  assert.equal(queue.remaining().length, 0);
});

test("trailing single flight performs one follow-up drain when work arrives mid-flight", async () => {
  const flights = createKeyedTrailingSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = flights.run("employee-1", async () => {
    calls += 1;
    await gate;
    return calls;
  });
  await Promise.resolve();
  const second = flights.run("employee-1", async () => {
    calls += 1;
    return calls;
  });
  const third = flights.run("employee-1", async () => {
    calls += 1;
    return calls;
  });
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [2, 2, 2]);
  assert.equal(calls, 2);
});

test("location keys are deterministic and queued duplicates collapse", () => {
  const point = { timestamp: 1_777_000_000_123, latitude: 24.81, longitude: 67.04 };
  const key = deterministicLocationKey("employee-1", point);
  assert.match(key, /^[a-zA-Z0-9._-]{1,36}$/);
  assert.equal(key, deterministicLocationKey("employee-1", point));
  assert.notEqual(key, deterministicLocationKey("employee-2", point));
  assert.equal(deduplicateLocationItems([
    { idempotencyKey: key },
    { idempotencyKey: key },
    { idempotencyKey: "different" },
  ]).length, 2);
});

test("normal reconnect respects location rejection, permanent failure, and retry backoff", () => {
  const nowMs = new Date("2026-08-25T10:00:00.000Z").valueOf();
  assert.equal(canAttemptLocationItem({ syncRejectedAt: "2026-08-25T09:00:00.000Z" }, { nowMs }), false);
  assert.equal(canAttemptLocationItem({ syncRetryable: false }, { nowMs }), false);
  assert.equal(canAttemptLocationItem({ syncRetryable: true, nextSyncAttemptAt: "2026-08-25T10:01:00.000Z" }, { nowMs }), false);
  assert.equal(canAttemptLocationItem({ syncRetryable: true, nextSyncAttemptAt: "2026-08-25T09:59:00.000Z" }, { nowMs }), true);
  assert.equal(canAttemptLocationItem({ syncRetryable: false }, { force: true, nowMs }), true);
  // Server-rejected points are quarantined even during an explicit override.
  assert.equal(canAttemptLocationItem({ syncRejectedAt: "2026-08-25T09:00:00.000Z" }, { force: true, nowMs }), false);
  // Authentication pause is lifted only after a fresh session explicitly
  // resumes the employee queue; network callbacks cannot force through it.
  assert.equal(canAttemptLocationItem({ syncAuthPausedAt: "2026-08-25T09:00:00.000Z" }, { force: true, nowMs }), false);
});

test("a 401 from a replaced authentication epoch cannot pause the new session", () => {
  assert.equal(authenticationAttemptWasReplaced(4, 5), true);
  assert.equal(authenticationAttemptWasReplaced(5, 5), false);
});

test("location storage plans cap every chunk at 200 points and restore in order", () => {
  const points = Array.from({ length: 451 }, (_, index) => ({ idempotencyKey: `point-${index}` }));
  const plan = createLocationQueueStoragePlan(points, "generation-1", "queue-chunk-", "2026-08-25T10:00:00.000Z");
  assert.equal(plan.manifest.count, 451);
  assert.equal(plan.manifest.chunkSize, LOCATION_STORAGE_CHUNK_SIZE);
  assert.deepEqual(plan.chunks.map((chunk) => chunk.items.length), [200, 200, 51]);
  assert.equal(Math.max(...plan.chunks.map((chunk) => chunk.items.length)), 200);

  const restored = restoreLocationQueueChunks(
    plan.manifest,
    new Map(plan.chunks.map((chunk) => [chunk.key, chunk.items])),
  );
  assert.deepEqual(restored, points);
});

test("location storage refuses overflow or incomplete generations without trimming", () => {
  const overflow = Array.from({ length: MAX_LOCATION_QUEUE_ITEMS + 1 }, (_, index) => ({ idempotencyKey: `point-${index}` }));
  assert.throws(
    () => createLocationQueueStoragePlan(overflow, "generation-overflow", "queue-chunk-"),
    /capacity/,
  );

  const plan = createLocationQueueStoragePlan(
    Array.from({ length: 201 }, (_, index) => ({ idempotencyKey: `point-${index}` })),
    "generation-incomplete",
    "queue-chunk-",
  );
  assert.throws(
    () => restoreLocationQueueChunks(plan.manifest, new Map([[plan.chunks[0].key, plan.chunks[0].items]])),
    /missing or invalid/,
  );
});
