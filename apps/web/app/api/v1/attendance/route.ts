import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json();
  const action = body.action === "check_out" ? "check_out" : "check_in";
  const latitude = number(body.latitude), longitude = number(body.longitude), accuracy = number(body.accuracy);
  const idempotencyKey = text(body.idempotencyKey, 64);
  if (latitude === null || longitude === null || accuracy === null || !idempotencyKey) {
    return NextResponse.json({ error: "A valid GPS point and operation ID are required." }, { status: 400 });
  }
  const db = createAdminTablesDb();
  const duplicate = (await db.listRows({ databaseId, tableId: "attendance_records", queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)] })).rows[0];
  if (duplicate) return NextResponse.json({ ok: true, attendanceId: duplicate.$id, status: duplicate.status });
  const capturedDate = new Date(text(body.capturedAt, 40));
  const capturedAt = Number.isNaN(capturedDate.valueOf()) ? new Date().toISOString() : capturedDate.toISOString();
  const date = workDate(new Date(capturedAt));
  const existing = (await db.listRows({ databaseId, tableId: "attendance_records", queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.limit(1)] })).rows[0];
  const now = new Date().toISOString();
  if (action === "check_out") {
    if (!existing) return NextResponse.json({ error: "Check in before checking out." }, { status: 409 });
    if (existing.status === "checked_out") return NextResponse.json({ ok: true, attendanceId: existing.$id, status: existing.status });
    const row = await db.updateRow({ databaseId, tableId: "attendance_records", rowId: existing.$id, data: {
      check_out_at: capturedAt, check_out_latitude: latitude, check_out_longitude: longitude, check_out_accuracy: accuracy, status: "checked_out",
    } });
    await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
      employee_id: actor.employee.$id, captured_at: capturedAt, received_at: now,
      latitude, longitude, accuracy, source: "shift_check_out", work_date: date,
    }, permissions: [] });
    return NextResponse.json({ ok: true, attendanceId: row.$id, status: row.status });
  }
  if (existing) {
    if (existing.status === "checked_out") return NextResponse.json({ error: "Today's work is already finished." }, { status: 409 });
    return NextResponse.json({ ok: true, attendanceId: existing.$id, status: existing.status });
  }
  const row = await db.createRow({ databaseId, tableId: "attendance_records", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, work_date: date, check_in_at: capturedAt,
    check_in_latitude: latitude, check_in_longitude: longitude, check_in_accuracy: accuracy,
    status: "checked_in", idempotency_key: idempotencyKey,
  }, permissions: [] });
  await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, captured_at: capturedAt, received_at: now,
    latitude, longitude, accuracy, source: "shift_check_in", work_date: date,
  }, permissions: [] });
  return NextResponse.json({ ok: true, attendanceId: row.$id, status: row.status }, { status: 201 });
}
