import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { evaluateGeofence } from "@fieldops/domain";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const body = await request.json();
  const outletId = text(body.outletId, 36), routeId = text(body.routeId, 36), idempotencyKey = text(body.idempotencyKey, 64);
  const latitude = number(body.latitude), longitude = number(body.longitude), accuracy = number(body.accuracy);
  if (!outletId || !idempotencyKey || latitude === null || longitude === null || accuracy === null) {
    return NextResponse.json({ error: "Outlet, GPS point, and operation ID are required." }, { status: 400 });
  }
  const db = createAdminTablesDb();
  const duplicate = (await db.listRows({ databaseId, tableId: "visits", queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)] })).rows[0];
  if (duplicate) return NextResponse.json({ ok: true, visitId: duplicate.$id, geofenceAccepted: duplicate.geofence_accepted, distanceMeters: duplicate.geofence_distance_m });
  const attendance = (await db.listRows({ databaseId, tableId: "attendance_records", queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", workDate()), Query.equal("status", "checked_in"), Query.limit(1)] })).rows[0];
  if (!attendance) return NextResponse.json({ error: "Check in for your shift first." }, { status: 409 });
  const outlet = await db.getRow({ databaseId, tableId: "outlets", rowId: outletId });
  if (outlet.assigned_employee_id !== actor.employee.$id) return NextResponse.json({ error: "This outlet is not assigned to you." }, { status: 403 });
  const geofence = evaluateGeofence(
    { latitude: Number(outlet.latitude), longitude: Number(outlet.longitude) },
    { latitude, longitude },
    200,
    Math.max(0, accuracy),
  );
  const now = new Date().toISOString();
  const visit = await db.createRow({ databaseId, tableId: "visits", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, outlet_id: outletId, ...(routeId ? { route_assignment_id: routeId } : {}),
    work_date: workDate(), check_in_at: now, latitude, longitude, accuracy,
    geofence_distance_m: geofence.distanceMeters, geofence_accepted: geofence.accepted,
    status: "active", idempotency_key: idempotencyKey, device_captured_at: text(body.capturedAt, 40) || now,
  }, permissions: [] });
  await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, visit_id: visit.$id, captured_at: text(body.capturedAt, 40) || now,
    received_at: now, latitude, longitude, accuracy, source: "visit_check_in",
  }, permissions: [] });
  if (routeId) {
    try { await db.updateRow({ databaseId, tableId: "route_assignments", rowId: routeId, data: { status: "active" } }); } catch { /* The visit remains valid if an old plan changed. */ }
  }
  return NextResponse.json({ ok: true, visitId: visit.$id, geofenceAccepted: geofence.accepted, distanceMeters: geofence.distanceMeters }, { status: 201 });
}
