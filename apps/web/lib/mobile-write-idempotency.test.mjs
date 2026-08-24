import assert from "node:assert/strict";
import test from "node:test";

import {
  IdempotencyConflictError,
  attendanceReplayMatches,
  ensureLocationSideEffect,
  orderReplayMatches,
  stableOperationId,
} from "./mobile-write-idempotency.ts";

const point = {
  operationKey: "attendance:check_in:start_123",
  employeeId: "employee-1",
  capturedAt: "2026-08-24T05:00:00.000Z",
  receivedAt: "2026-08-24T05:01:00.000Z",
  latitude: 24.81,
  longitude: 67.03,
  accuracy: 12,
  source: "shift_check_in",
  workDate: "2026-08-24",
};

function appwriteError(code) {
  return Object.assign(new Error(`Appwrite ${code}`), { code });
}

function storedPoint(id = stableOperationId("location", point.operationKey)) {
  return {
    $id: id,
    employee_id: point.employeeId,
    captured_at: point.capturedAt,
    received_at: point.receivedAt,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy,
    source: point.source,
    work_date: point.workDate,
  };
}

test("stableOperationId is deterministic and Appwrite-safe", () => {
  const first = stableOperationId("location", point.operationKey);
  assert.equal(first, stableOperationId("location", point.operationKey));
  assert.match(first, /^[a-zA-Z0-9_-]{1,36}$/);
});

test("ensureLocationSideEffect creates one deterministic GPS row", async () => {
  const created = [];
  const db = {
    getRow: async () => { throw appwriteError(404); },
    listRows: async () => ({ rows: [] }),
    createRow: async (request) => { created.push(request); return { $id: request.rowId }; },
  };

  const result = await ensureLocationSideEffect(db, "fieldops", point);
  assert.equal(result.created, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].rowId, stableOperationId("location", point.operationKey));
  assert.equal(created[0].data.idempotency_key, created[0].rowId);
});

test("ensureLocationSideEffect replays an existing deterministic GPS row without another write", async () => {
  let lists = 0;
  let creates = 0;
  const db = {
    getRow: async () => storedPoint(),
    listRows: async () => { lists += 1; return { rows: [] }; },
    createRow: async () => { creates += 1; },
  };

  assert.deepEqual(
    await ensureLocationSideEffect(db, "fieldops", point),
    { rowId: stableOperationId("location", point.operationKey), created: false },
  );
  assert.equal(lists, 0);
  assert.equal(creates, 0);
});

test("ensureLocationSideEffect recognizes a legacy random-ID GPS row", async () => {
  let creates = 0;
  const legacy = storedPoint("legacy-random-id");
  const db = {
    getRow: async () => { throw appwriteError(404); },
    listRows: async () => ({ rows: [legacy] }),
    createRow: async () => { creates += 1; },
  };

  const result = await ensureLocationSideEffect(db, "fieldops", point);
  assert.deepEqual(result, { rowId: "legacy-random-id", created: false });
  assert.equal(creates, 0);
});

test("ensureLocationSideEffect reconciles an ambiguous create timeout", async () => {
  let reads = 0;
  const db = {
    getRow: async () => {
      reads += 1;
      if (reads === 1) throw appwriteError(404);
      return storedPoint();
    },
    listRows: async () => ({ rows: [] }),
    createRow: async () => { throw new Error("response lost after commit"); },
  };

  assert.deepEqual(
    await ensureLocationSideEffect(db, "fieldops", point),
    { rowId: stableOperationId("location", point.operationKey), created: false },
  );
});

test("ensureLocationSideEffect rejects a deterministic row owned by another employee", async () => {
  const db = {
    getRow: async () => ({ ...storedPoint(), employee_id: "employee-2" }),
    listRows: async () => ({ rows: [] }),
    createRow: async () => undefined,
  };
  await assert.rejects(
    ensureLocationSideEffect(db, "fieldops", point),
    IdempotencyConflictError,
  );
});

test("attendance replay matching validates ownership, action key, point, and device time", () => {
  const replay = {
    employeeId: "employee-1",
    action: "check_out",
    idempotencyKey: "finish-1",
    capturedAt: "2026-08-24T12:00:00.000Z",
    latitude: 24.82,
    longitude: 67.04,
    accuracy: 9,
  };
  const row = {
    employee_id: replay.employeeId,
    check_out_idempotency_key: replay.idempotencyKey,
    check_out_at: replay.capturedAt,
    check_out_latitude: replay.latitude,
    check_out_longitude: replay.longitude,
    check_out_accuracy: replay.accuracy,
  };
  assert.equal(attendanceReplayMatches(row, replay), true);
  assert.equal(attendanceReplayMatches({ ...row, employee_id: "employee-2" }, replay), false);
  assert.equal(attendanceReplayMatches({ ...row, check_out_latitude: 1 }, replay), false);
});

test("order replay matching rejects a reused key with changed business data", () => {
  const replay = {
    employeeId: "employee-1",
    idempotencyKey: "order-1",
    workDate: "2026-08-24",
    outletId: "outlet-1",
    customerName: "Customer",
    phone: "03001234567",
    address: "Market Road",
    productName: "Rice",
    quantityKg: 10,
    unitPrice: 250,
    totalAmount: 2500,
    notes: "Deliver tomorrow",
    latitude: 24.82,
    longitude: 67.04,
    accuracy: 9,
    capturedAt: "2026-08-24T12:00:00.000Z",
  };
  const row = {
    employee_id: replay.employeeId,
    idempotency_key: replay.idempotencyKey,
    work_date: replay.workDate,
    outlet_id: replay.outletId,
    customer_name: replay.customerName,
    phone: replay.phone,
    address: replay.address,
    product_name: replay.productName,
    quantity_kg: replay.quantityKg,
    unit_price: replay.unitPrice,
    total_amount: replay.totalAmount,
    notes: replay.notes,
    latitude: replay.latitude,
    longitude: replay.longitude,
    accuracy: replay.accuracy,
    captured_at: replay.capturedAt,
  };
  assert.equal(orderReplayMatches(row, replay), true);
  assert.equal(orderReplayMatches({ ...row, quantity_kg: 11 }, replay), false);
  assert.equal(orderReplayMatches({ ...row, employee_id: "employee-2" }, replay), false);
});
