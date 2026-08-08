import { ID } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { NextResponse } from "next/server";
import { createAdminStorage, createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text } from "../../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID ?? "visit-evidence";

function safeName(name: string, fallback: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  return cleaned || fallback;
}

export async function POST(request: Request, context: { params: Promise<{ visitId: string }> }) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { visitId } = await context.params;
  const db = createAdminTablesDb();
  let visit;
  try { visit = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }); } catch { return NextResponse.json({ error: "Visit not found." }, { status: 404 }); }
  if (visit.employee_id !== actor.employee.$id) return NextResponse.json({ error: "This visit belongs to another salesperson." }, { status: 403 });
  const form = await request.formData();
  const latitude = number(form.get("latitude")) ?? Number(visit.latitude);
  const longitude = number(form.get("longitude")) ?? Number(visit.longitude);
  const accuracy = number(form.get("accuracy")) ?? Number(visit.accuracy);
  const capturedAt = text(form.get("capturedAt"), 40) || new Date().toISOString();
  const now = new Date().toISOString();
  let evidenceCount = 0;
  for (const kind of ["photo", "audio"] as const) {
    const value = form.get(kind);
    if (!(value instanceof File) || value.size === 0) continue;
    const filename = safeName(value.name, `${kind}-${visitId}`);
    const stored = await createAdminStorage().createFile({
      bucketId,
      fileId: ID.unique(),
      file: InputFile.fromBuffer(Buffer.from(await value.arrayBuffer()), filename),
      permissions: [],
    });
    await db.createRow({ databaseId, tableId: "visit_evidence", rowId: ID.unique(), data: {
      visit_id: visitId, employee_id: actor.employee.$id, outlet_id: String(visit.outlet_id), type: kind,
      file_id: stored.$id, filename, mime_type: value.type || "application/octet-stream",
      captured_at: capturedAt, latitude, longitude, accuracy,
    }, permissions: [] });
    evidenceCount += 1;
  }
  const orderAmount = number(form.get("orderAmount"));
  await db.updateRow({ databaseId, tableId: "visits", rowId: visitId, data: {
    check_out_at: now, outcome: text(form.get("outcome"), 48) || "Visit completed",
    notes: text(form.get("notes"), 4000), ...(orderAmount === null ? {} : { order_amount: orderAmount }), status: "completed",
  } });
  await db.createRow({ databaseId, tableId: "location_points", rowId: ID.unique(), data: {
    employee_id: actor.employee.$id, visit_id: visitId, captured_at: capturedAt, received_at: now,
    latitude, longitude, accuracy, source: "visit_check_out",
  }, permissions: [] });
  if (visit.route_assignment_id) {
    try { await db.updateRow({ databaseId, tableId: "route_assignments", rowId: String(visit.route_assignment_id), data: { status: "completed", completed_at: now } }); } catch { /* Visit completion remains authoritative. */ }
  }
  return NextResponse.json({ ok: true, visitId, evidenceCount });
}
