import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import {
  IdempotencyConflictError,
  attendanceReplayMatches,
  ensureLocationSideEffect,
  stableOperationId,
  type AttendanceReplay,
  type DataRow,
} from "../../../../lib/mobile-write-idempotency";
import { mobileActor, number, text, workDate } from "../../../../lib/mobile-auth";
import { attendanceTransition } from "../../../../lib/attendance-transition";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action !== "check_in" && body.action !== "check_out") {
    return NextResponse.json({ error: "A valid attendance action is required." }, { status: 400 });
  }
  const action = body.action;
  const latitude = strictNumber(body.latitude);
  const longitude = strictNumber(body.longitude);
  const accuracy = strictNumber(body.accuracy);
  const rawIdempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
  const idempotencyKey = text(rawIdempotencyKey, 64);
  const capturedDate = new Date(text(body.capturedAt, 40));
  if (
    rawIdempotencyKey !== idempotencyKey
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(idempotencyKey)
    || latitude === null
    || longitude === null
    || accuracy === null
    || Math.abs(latitude) > 90
    || Math.abs(longitude) > 180
    || accuracy < 0
    || Number.isNaN(capturedDate.valueOf())
  ) {
    return NextResponse.json({ error: "A valid GPS point, device time, and operation ID are required." }, { status: 400 });
  }

  const capturedAt = capturedDate.toISOString();
  const date = workDate(capturedDate);
  const expected: AttendanceReplay = {
    employeeId: actor.employee.$id,
    action,
    idempotencyKey,
    capturedAt,
    latitude,
    longitude,
    accuracy,
  };
  const db = createAdminTablesDb();

  try {
    const duplicate = await attendanceByOperation(db, idempotencyKey);
    if (duplicate) {
      if (!attendanceReplayMatches(duplicate, expected)) throw new IdempotencyConflictError();
      await ensureAttendanceLocation(db, expected, date);
      return NextResponse.json({ ok: true, attendanceId: duplicate.$id, status: duplicate.status });
    }

    const sessions = (await db.listRows({ databaseId, tableId: "attendance_records", queries: [
      Query.equal("employee_id", actor.employee.$id),
      Query.equal("work_date", date),
      Query.limit(100),
    ] })).rows;
    const transition = attendanceTransition(action, capturedAt, sessions as DataRow[]);

    if (transition.kind === "confirm") {
      await ensureAttendanceLocation(db, expected, date);
      return NextResponse.json({
        ok: true,
        attendanceId: transition.session.$id,
        status: transition.session.status,
        reconciled: true,
      });
    }
    if (transition.kind === "reject") {
      return NextResponse.json({ error: transition.error }, { status: 409 });
    }

    if (action === "check_out") {
      if (transition.kind !== "update") {
        return NextResponse.json({ error: "Start work before finishing the session." }, { status: 409 });
      }
      const active = transition.session;
      let row: DataRow;
      try {
        row = await db.updateRow({ databaseId, tableId: "attendance_records", rowId: active.$id, data: {
          check_out_at: capturedAt,
          check_out_latitude: latitude,
          check_out_longitude: longitude,
          check_out_accuracy: accuracy,
          check_out_idempotency_key: idempotencyKey,
          status: "checked_out",
        } }) as DataRow;
      } catch (updateError) {
        const committed = await attendanceByOperation(db, idempotencyKey).catch(() => null);
        if (!committed) throw updateError;
        if (!attendanceReplayMatches(committed, expected)) throw new IdempotencyConflictError();
        row = committed;
      }
      await ensureAttendanceLocation(db, expected, date);
      return NextResponse.json({ ok: true, attendanceId: row.$id, status: row.status });
    }

    let row: DataRow;
    let created = true;
    try {
      row = await db.createRow({
        databaseId,
        tableId: "attendance_records",
        rowId: stableOperationId("attendance", idempotencyKey),
        data: {
          employee_id: actor.employee.$id,
          work_date: date,
          check_in_at: capturedAt,
          check_in_latitude: latitude,
          check_in_longitude: longitude,
          check_in_accuracy: accuracy,
          status: "checked_in",
          idempotency_key: idempotencyKey,
        },
        permissions: [],
      }) as DataRow;
    } catch (createError) {
      const committed = await attendanceByOperation(db, idempotencyKey).catch(() => null);
      if (!committed) throw createError;
      if (!attendanceReplayMatches(committed, expected)) throw new IdempotencyConflictError();
      row = committed;
      created = false;
    }
    await ensureAttendanceLocation(db, expected, date);
    return NextResponse.json(
      { ok: true, attendanceId: row.$id, status: row.status },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

async function attendanceByOperation(
  db: ReturnType<typeof createAdminTablesDb>,
  idempotencyKey: string,
): Promise<DataRow | null> {
  return ((await db.listRows({
    databaseId,
    tableId: "attendance_records",
    queries: [
      Query.or([
        Query.equal("idempotency_key", idempotencyKey),
        Query.equal("check_out_idempotency_key", idempotencyKey),
      ]),
      Query.limit(1),
    ],
  })).rows[0] as DataRow | undefined) ?? null;
}

function ensureAttendanceLocation(
  db: ReturnType<typeof createAdminTablesDb>,
  expected: AttendanceReplay,
  date: string,
) {
  return ensureLocationSideEffect(db, databaseId, {
    operationKey: `attendance:${expected.action}:${expected.idempotencyKey}`,
    employeeId: expected.employeeId,
    capturedAt: expected.capturedAt,
    receivedAt: new Date().toISOString(),
    latitude: expected.latitude,
    longitude: expected.longitude,
    accuracy: expected.accuracy,
    source: expected.action === "check_in" ? "shift_check_in" : "shift_check_out",
    workDate: date,
  });
}

function strictNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return number(value);
}
