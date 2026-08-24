import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmedLocationIds,
  createKeyedSingleFlight,
  drainLocationOutbox,
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
