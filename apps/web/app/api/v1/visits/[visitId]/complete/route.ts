import { createHash } from "node:crypto";
import { ID, Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { NextResponse } from "next/server";
import { evaluateGeofence } from "@fieldops/domain";
import { createAdminStorage, createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text } from "../../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID ?? "visit-evidence";

function safeName(name: string, fallback: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  return cleaned || fallback;
}

const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export async function POST(request: Request, context: { params: Promise<{ visitId: string }> }) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { visitId } = await context.params;
  const db = createAdminTablesDb();
  let visit;
  try { visit = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }); } catch { return NextResponse.json({ error: "Visit not found." }, { status: 404 }); }
  if (visit.employee_id !== actor.employee.$id) return NextResponse.json({ error: "This visit belongs to another salesperson." }, { status: 403 });
  if (visit.status === "completed") {
    const evidence = await db.listRows({ databaseId, tableId: "visit_evidence", queries: [Query.equal("visit_id", visitId), Query.limit(10)] });
    return NextResponse.json({ ok: true, visitId, evidenceCount: evidence.total });
  }
  const form = await request.formData();
  const latitude = number(form.get("latitude")) ?? Number(visit.latitude);
  const longitude = number(form.get("longitude")) ?? Number(visit.longitude);
  const accuracy = number(form.get("accuracy")) ?? Number(visit.accuracy);
  const capturedAt = text(form.get("capturedAt"), 40) || new Date().toISOString();
  const now = new Date().toISOString();
  const photo = form.get("photo"), audio = form.get("audio");
  if (!(photo instanceof File) || photo.size === 0 || !(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "A visit photo and audio note are both required." }, { status: 422 });
  }
  const selfInitiated = visit.visit_type === "self_initiated" || !visit.route_assignment_id;
  const visitPoint = selfInitiated
    ? { latitude: Number(visit.latitude), longitude: Number(visit.longitude) }
    : await db.getRow({ databaseId, tableId: "outlets", rowId: String(visit.outlet_id) }).then((outlet) => ({ latitude: Number(outlet.latitude), longitude: Number(outlet.longitude) }));
  const geofence = evaluateGeofence(
    visitPoint,
    { latitude, longitude },
    70,
    0,
  );
  if (!geofence.accepted) {
    return NextResponse.json({ error: `Return to the visit point. You are ${geofence.distanceMeters} m away; the maximum is 70 m.` }, { status: 422 });
  }
  let evidenceCount = 0;
  const storage = createAdminStorage();
  for (const [kind, value] of [["photo", photo], ["audio", audio]] as const) {
    const filename = safeName(value.name, `${kind}-${visitId}`);
    const evidenceId = stableId("evidence", `${visitId}:${kind}`);
    let fileId = evidenceId;
    try {
      const stored = await storage.createFile({
        bucketId,
        fileId: evidenceId,
        file: InputFile.fromBuffer(Buffer.from(await value.arrayBuffer()), filename),
        permissions: [],
      });
      fileId = stored.$id;
    } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && Number(error.code) === 409)) throw error;
    }
    try { await db.createRow({ databaseId, tableId: "visit_evidence", rowId: evidenceId, data: {
      visit_id: visitId, employee_id: actor.employee.$id, outlet_id: String(visit.outlet_id), type: kind,
      file_id: fileId, filename, mime_type: value.type || "application/octet-stream",
      captured_at: capturedAt, latitude, longitude, accuracy,
    }, permissions: [] }); } catch (error) {
      if (!(typeof error === "object" && error && "code" in error && Number(error.code) === 409)) throw error;
    }
    evidenceCount += 1;
  }
  const orderAmount = number(form.get("orderAmount"));
  await db.updateRow({ databaseId, tableId: "visits", rowId: visitId, data: {
    check_out_at: now, outcome: text(form.get("outcome"), 48) || "Visit completed",
    notes: text(form.get("notes"), 4000), ...(orderAmount === null ? {} : { order_amount: orderAmount }),
    completion_distance_m: geofence.distanceMeters, status: "completed",
  } });
  await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, visit_id: visitId, captured_at: capturedAt, received_at: now,
    latitude, longitude, accuracy, source: "visit_check_out", work_date: String(visit.work_date),
  }, permissions: [] });
  if (visit.route_assignment_id) {
    try { await db.updateRow({ databaseId, tableId: "route_assignments", rowId: String(visit.route_assignment_id), data: { status: "completed", completed_at: now } }); } catch { /* Visit completion remains authoritative. */ }
  }
  return NextResponse.json({ ok: true, visitId, evidenceCount });
}
