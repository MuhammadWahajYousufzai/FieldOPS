import assert from "node:assert/strict";
import test from "node:test";

import { listAllRows, listAllRowsChecked } from "./table-data.ts";

function row(id) {
  return { $id: id };
}

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    async listRows(input) {
      calls.push(input);
      const decoded = input.queries.map((query) => JSON.parse(query));
      const limit = decoded.find((query) => query.method === "limit")?.values[0] ?? 25;
      const cursor = decoded.find((query) => query.method === "cursorAfter")?.values[0];
      const start = cursor ? rows.findIndex((item) => item.$id === cursor) + 1 : 0;
      return { rows: rows.slice(start, start + limit), total: rows.length };
    },
  };
}

test("listAllRows paginates past Appwrite's page limit", async () => {
  const source = Array.from({ length: 205 }, (_, index) => row(`row_${String(index).padStart(3, "0")}`));
  const db = fakeDb(source);
  const result = await listAllRows(db, "fieldops", "employees", [], 1_000);

  assert.deepEqual(result.map((item) => item.$id), source.map((item) => item.$id));
  assert.equal(db.calls.length, 3);
  assert.deepEqual(db.calls.map((call) => call.total), [false, false, false]);
});

test("checked pagination accepts the exact bound and forwards a transaction", async () => {
  const source = Array.from({ length: 200 }, (_, index) => row(`row_${String(index).padStart(3, "0")}`));
  const db = fakeDb(source);
  const result = await listAllRowsChecked(db, "fieldops", "employee_assignments", [], 200, "transaction_1");

  assert.equal(result.length, 200);
  assert.equal(db.calls.length, 3);
  assert.equal(db.calls.every((call) => call.transactionId === "transaction_1"), true);
});

test("checked pagination fails closed when one row exceeds the safety bound", async () => {
  const source = Array.from({ length: 201 }, (_, index) => row(`row_${String(index).padStart(3, "0")}`));
  const db = fakeDb(source);

  await assert.rejects(
    () => listAllRowsChecked(db, "fieldops", "employee_assignments", [], 200),
    /exceeds the safe 200-row operation limit/,
  );
  assert.equal(db.calls.length, 3);
});
