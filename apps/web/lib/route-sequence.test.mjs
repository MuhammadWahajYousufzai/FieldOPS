import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateRouteSequence,
  nextRouteSequence,
  routeSequenceCounterId,
} from "./route-sequence.ts";

test("route sequence counters have deterministic per-salesperson/day IDs", () => {
  const first = routeSequenceCounterId("employee_1", "2026-08-25");
  assert.equal(first, routeSequenceCounterId("employee_1", "2026-08-25"));
  assert.notEqual(first, routeSequenceCounterId("employee_2", "2026-08-25"));
  assert.notEqual(first, routeSequenceCounterId("employee_1", "2026-08-26"));
  assert.ok(first.length <= 36);
});

test("nextRouteSequence advances beyond both the counter and existing routes", () => {
  assert.equal(nextRouteSequence(4, 2), 5);
  assert.equal(nextRouteSequence(2, 4), 5);
  assert.equal(nextRouteSequence(undefined, undefined), 1);
});

test("allocateRouteSequence creates a missing counter from the latest route inside the transaction", async () => {
  const calls = [];
  const db = {
    getRow: async (input) => { calls.push(["get", input]); throw { code: 404 }; },
    listRows: async (input) => { calls.push(["list", input]); return { rows: [{ sequence: 7 }] }; },
    createRow: async (input) => { calls.push(["create", input]); return input.data; },
  };
  const sequence = await allocateRouteSequence(db, "fieldops", "employee_1", "2026-08-25", "tx_1");
  assert.equal(sequence, 8);
  const create = calls.find(([kind]) => kind === "create")[1];
  assert.equal(create.transactionId, "tx_1");
  assert.equal(create.data.last_sequence, 8);
  assert.equal(calls.find(([kind]) => kind === "list")[1].ttl, 0);
});

test("allocateRouteSequence catches up a lagging counter with one atomic increment", async () => {
  const calls = [];
  const db = {
    getRow: async () => ({ last_sequence: 3 }),
    listRows: async () => ({ rows: [{ sequence: 5 }] }),
    incrementRowColumn: async (input) => { calls.push(["increment", input]); return { last_sequence: 6 }; },
  };
  const sequence = await allocateRouteSequence(db, "fieldops", "employee_1", "2026-08-25", "tx_2");
  assert.equal(sequence, 6);
  assert.equal(calls[0][1].column, "last_sequence");
  assert.equal(calls[0][1].value, 3);
  assert.equal(calls[0][1].transactionId, "tx_2");
});
