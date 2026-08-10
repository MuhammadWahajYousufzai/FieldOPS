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
  const outletId = text(body.outletId, 36), routeId = text(body.routeId, 36), visitId = text(body.visitId, 36), idempotencyKey = text(body.idempotencyKey, 64);
  const latitude = number(body.latitude), longitude = number(body.longitude), accuracy = number(body.accuracy);
  if (!outletId || !idempotencyKey || latitude === null || longitude === null || accuracy === null) {
    return NextResponse.json({ error: "Outlet, GPS point, and operation ID are required." }, { status: 400 });
  }
  const db = createAdminTablesDb();
  const duplicate = (await db.listRows({ databaseId, tableId: "visits", queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)] })).rows[0];
  if (duplicate) return NextResponse.json({ ok: true, visitId: duplicate.$id, geofenceAccepted: duplicate.geofence_accepted, distanceMeters: duplicate.geofence_distance_m });
  if (visitId) {
    try {
      const existingVisit = await db.getRow({ databaseId, tableId: "visits", rowId: visitId });
      if (existingVisit.employee_id === actor.employee.$id) return NextResponse.json({ ok: true, visitId: existingVisit.$id, geofenceAccepted: existingVisit.geofence_accepted, distanceMeters: existingVisit.geofence_distance_m });
      return NextResponse.json({ error: "This visit ID belongs to another salesperson." }, { status: 403 });
    } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && Number(error.code) === 404)) throw error;
    }
  }
  const capturedDate = new Date(text(body.capturedAt, 40));
  const capturedAt = Number.isNaN(capturedDate.valueOf()) ? new Date().toISOString() : capturedDate.toISOString();
  const date = workDate(new Date(capturedAt));
  const attendance = (await db.listRows({ databaseId, tableId: "attendance_records", queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.equal("status", "checked_in"), Query.limit(1)] })).rows[0];
  if (!attendance) return NextResponse.json({ error: "Check in for your shift first." }, { status: 409 });
  const outlet = await db.getRow({ databaseId, tableId: "outlets", rowId: outletId });
  const assignment = routeId
    ? await db.getRow({ databaseId, tableId: "route_assignments", rowId: routeId }).catch(() => null)
    : (await db.listRows({ databaseId, tableId: "route_assignments", queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("outlet_id", outletId), Query.equal("work_date", date), Query.limit(1)] })).rows[0];
  if (!assignment || assignment.employee_id !== actor.employee.$id || assignment.outlet_id !== outletId || assignment.work_date !== date) {
    return NextResponse.json({ error: "This visit is not assigned to you for this date." }, { status: 403 });
  }
  const geofence = evaluateGeofence(
    { latitude: Number(outlet.latitude), longitude: Number(outlet.longitude) },
    { latitude, longitude },
    70,
    0,
  );
  if (!geofence.accepted) return NextResponse.json({ error: `Move closer to the visit location. You are ${geofence.distanceMeters} m away; the maximum is 70 m.`, distanceMeters: geofence.distanceMeters }, { status: 422 });
  const now = new Date().toISOString();
  const visit = await db.createRow({ databaseId, tableId: "visits", rowId: visitId || ID.unique(), data: {
    employee_id: actor.employee.$id, outlet_id: outletId, route_assignment_id: assignment.$id,
    work_date: date, check_in_at: capturedAt, latitude, longitude, accuracy,
    geofence_distance_m: geofence.distanceMeters, geofence_accepted: geofence.accepted,
    status: "active", idempotency_key: idempotencyKey, device_captured_at: capturedAt,
  }, permissions: [] });
  await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, visit_id: visit.$id, captured_at: capturedAt,
    received_at: now, latitude, longitude, accuracy, source: "visit_check_in", work_date: date,
  }, permissions: [] });
  try { await db.updateRow({ databaseId, tableId: "route_assignments", rowId: assignment.$id, data: { status: "active" } }); } catch { /* The visit remains valid if an old plan changed. */ }
  return NextResponse.json({ ok: true, visitId: visit.$id, geofenceAccepted: geofence.accepted, distanceMeters: geofence.distanceMeters }, { status: 201 });
}
