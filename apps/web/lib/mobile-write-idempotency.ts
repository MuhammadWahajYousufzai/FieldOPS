import { createHash } from "node:crypto";
import { Query, type Models, type TablesDB } from "node-appwrite";

export type DataRow = Models.Row & Record<string, unknown>;

type MobileWriteDb = Pick<TablesDB, "createRow" | "getRow" | "listRows">;

export type LocationSideEffect = {
  operationKey: string;
  employeeId: string;
  capturedAt: string;
  receivedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  source: "shift_check_in" | "shift_check_out" | "order";
  workDate: string;
};

export type AttendanceReplay = {
  employeeId: string;
  action: "check_in" | "check_out";
  idempotencyKey: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number;
};

export type OrderReplay = {
  employeeId: string;
  idempotencyKey: string;
  workDate: string;
  outletId: string;
  customerName: string;
  phone: string;
  address: string;
  productName: string;
  quantityKg: number;
  unitPrice: number;
  totalAmount: number;
  notes: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: string;
};

export class IdempotencyConflictError extends Error {
  constructor(message = "This operation ID is already attached to different data.") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export function stableOperationId(prefix: string, value: string) {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 10) || "operation";
  return `${safePrefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function attendanceReplayMatches(row: DataRow, expected: AttendanceReplay) {
  const checkIn = expected.action === "check_in";
  return String(row.employee_id ?? "") === expected.employeeId
    && String(row[checkIn ? "idempotency_key" : "check_out_idempotency_key"] ?? "") === expected.idempotencyKey
    && sameInstant(row[checkIn ? "check_in_at" : "check_out_at"], expected.capturedAt)
    && sameNumber(row[checkIn ? "check_in_latitude" : "check_out_latitude"], expected.latitude)
    && sameNumber(row[checkIn ? "check_in_longitude" : "check_out_longitude"], expected.longitude)
    && sameNumber(row[checkIn ? "check_in_accuracy" : "check_out_accuracy"], expected.accuracy);
}

export function orderReplayMatches(row: DataRow, expected: OrderReplay) {
  return String(row.employee_id ?? "") === expected.employeeId
    && String(row.idempotency_key ?? "") === expected.idempotencyKey
    && String(row.work_date ?? "") === expected.workDate
    && String(row.outlet_id ?? "") === expected.outletId
    && String(row.customer_name ?? "") === expected.customerName
    && String(row.phone ?? "") === expected.phone
    && String(row.address ?? "") === expected.address
    && String(row.product_name ?? "") === expected.productName
    && sameNumber(row.quantity_kg, expected.quantityKg)
    && sameNumber(row.unit_price, expected.unitPrice)
    && sameNumber(row.total_amount, expected.totalAmount)
    && String(row.notes ?? "") === expected.notes
    && sameNumber(row.latitude, expected.latitude)
    && sameNumber(row.longitude, expected.longitude)
    && sameNumber(row.accuracy, expected.accuracy)
    && sameInstant(row.captured_at, expected.capturedAt);
}

export function locationSideEffectMatches(row: DataRow, expected: LocationSideEffect) {
  return String(row.employee_id ?? "") === expected.employeeId
    && sameInstant(row.captured_at, expected.capturedAt)
    && sameNumber(row.latitude, expected.latitude)
    && sameNumber(row.longitude, expected.longitude)
    && sameNumber(row.accuracy, expected.accuracy)
    && String(row.source ?? "") === expected.source
    && String(row.work_date ?? "") === expected.workDate;
}

export async function ensureLocationSideEffect(
  db: MobileWriteDb,
  databaseId: string,
  expected: LocationSideEffect,
) {
  const rowId = stableOperationId("location", expected.operationKey);
  try {
    const existing = await db.getRow({ databaseId, tableId: "location_points", rowId }) as DataRow;
    if (!locationSideEffectMatches(existing, expected)) throw new IdempotencyConflictError();
    return { rowId, created: false };
  } catch (error) {
    if (error instanceof IdempotencyConflictError) throw error;
    if (!hasCode(error, 404)) throw error;
  }

  // Older builds wrote this side effect with a random row ID and no
  // idempotency_key. Recognize that exact point before creating the new stable
  // row so an upgrade cannot duplicate already-confirmed GPS history.
  const legacy = await db.listRows({
    databaseId,
    tableId: "location_points",
    queries: [
      Query.equal("employee_id", expected.employeeId),
      Query.equal("captured_at", expected.capturedAt),
      Query.limit(100),
    ],
  });
  const legacyMatch = legacy.rows.find((row) => locationSideEffectMatches(row as DataRow, expected));
  if (legacyMatch) return { rowId: legacyMatch.$id, created: false };

  const data = {
    employee_id: expected.employeeId,
    captured_at: expected.capturedAt,
    received_at: expected.receivedAt,
    latitude: expected.latitude,
    longitude: expected.longitude,
    coordinates: [expected.longitude, expected.latitude],
    accuracy: expected.accuracy,
    source: expected.source,
    work_date: expected.workDate,
    idempotency_key: rowId,
  };
  try {
    await db.createRow({ databaseId, tableId: "location_points", rowId, data, permissions: [] });
    return { rowId, created: true };
  } catch (createError) {
    // A timeout can be ambiguous: Appwrite may have committed the row before
    // the caller lost the response. Re-read the deterministic ID before
    // deciding whether this attempt failed.
    try {
      const committed = await db.getRow({ databaseId, tableId: "location_points", rowId }) as DataRow;
      if (!locationSideEffectMatches(committed, expected)) throw new IdempotencyConflictError();
      return { rowId, created: false };
    } catch (readError) {
      if (readError instanceof IdempotencyConflictError) throw readError;
      throw createError;
    }
  }
}

function sameInstant(value: unknown, expected: string) {
  const actualTime = typeof value === "string" ? new Date(value).valueOf() : Number.NaN;
  const expectedTime = new Date(expected).valueOf();
  return Number.isFinite(actualTime) && actualTime === expectedTime;
}

function sameNumber(value: unknown, expected: number) {
  if (typeof value !== "number" && typeof value !== "string") return false;
  if (typeof value === "string" && value.trim() === "") return false;
  const actual = Number(value);
  return Number.isFinite(actual) && actual === expected;
}

function hasCode(error: unknown, code: number) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === code;
}
