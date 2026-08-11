import { createHash } from "node:crypto";
import { Models, Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { NextResponse } from "next/server";
import { evaluateGeofence, hasRequiredVisitEvidence } from "@fieldops/domain";
import { createAdminStorage, createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../../lib/mobile-auth";
import { evaluateTerritoryAccess, territoryAccessForEmployee } from "../../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID ?? "visit-evidence";
type DataRow = Models.Row & Record<string, unknown>;

const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

function safeName(name: string, fallback: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  return cleaned || fallback;
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === 404;
}

function isConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === 409;
}

function isoDate(value: unknown) {
  const parsed = new Date(text(value, 40));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function validPoint(point: { latitude: number | null; longitude: number | null; accuracy: number | null }): point is {
  latitude: number;
  longitude: number;
  accuracy: number;
} {
  return point.latitude !== null && point.longitude !== null && point.accuracy !== null
    && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180 && point.accuracy >= 0;
}

async function evidenceTypes(db: ReturnType<typeof createAdminTablesDb>, visitId: string) {
  const result = await db.listRows({
    databaseId,
    tableId: "visit_evidence",
    queries: [Query.equal("visit_id", visitId), Query.limit(10)],
  });
  return new Set(result.rows.map((row) => String(row.type)));
}

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });

  const form = await request.formData();
  const visitId = text(form.get("visitId"), 36);
  const idempotencyKey = text(form.get("idempotencyKey"), 64);
  const photo = form.get("photo"), audio = form.get("audio");
  if (!visitId || !idempotencyKey) {
    return NextResponse.json({ error: "Visit ID and submission ID are required." }, { status: 400 });
  }
  if (!(photo instanceof File) || photo.size === 0 || !(audio instanceof File) || audio.size === 0) {
    return NextResponse.json({ error: "A visit photo and audio note are both required." }, { status: 422 });
  }
  if (!photo.type.startsWith("image/") || !audio.type.startsWith("audio/")) {
    return NextResponse.json({ error: "The visit evidence must contain one image and one audio file." }, { status: 422 });
  }

  const db = createAdminTablesDb();
  let existing: DataRow | null = null;
  try {
    existing = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }) as DataRow;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (!existing) {
    existing = ((await db.listRows({
      databaseId,
      tableId: "visits",
      queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)],
    })).rows[0] as DataRow | undefined) ?? null;
  }
  if (existing && existing.employee_id !== actor.employee.$id) {
    return NextResponse.json({ error: "This visit belongs to another salesperson." }, { status: 403 });
  }
  if (existing?.status === "completed") {
    const types = await evidenceTypes(db, existing.$id);
    if (hasRequiredVisitEvidence({ photo: types.has("photo"), audio: types.has("audio") })) {
      return NextResponse.json({ ok: true, visitId: existing.$id, evidenceCount: types.size });
    }
  }

  const selfInitiated = existing
    ? existing.visit_type === "self_initiated" || !existing.route_assignment_id
    : text(form.get("visitType"), 24) === "self_initiated";
  const customerName = existing ? text(existing.customer_name, 160) : text(form.get("customerName"), 160);
  const customerAddress = existing ? text(existing.customer_address, 500) : text(form.get("customerAddress"), 500);
  const requestedOutletId = existing ? String(existing.outlet_id) : text(form.get("outletId"), 36);
  if (selfInitiated ? !customerName : !requestedOutletId) {
    return NextResponse.json({ error: selfInitiated ? "Customer or shop name is required." : "Assigned outlet is required." }, { status: 400 });
  }

  const checkInPoint = {
    latitude: existing ? number(existing.latitude) : number(form.get("checkInLatitude")),
    longitude: existing ? number(existing.longitude) : number(form.get("checkInLongitude")),
    accuracy: existing ? number(existing.accuracy) : number(form.get("checkInAccuracy")),
  };
  const checkInAt = existing ? isoDate(existing.check_in_at) : isoDate(form.get("checkInCapturedAt"));
  const completionPoint = {
    latitude: number(form.get("completionLatitude")),
    longitude: number(form.get("completionLongitude")),
    accuracy: number(form.get("completionAccuracy")),
  };
  const completionAt = isoDate(form.get("completionCapturedAt"));
  if (!validPoint(checkInPoint) || !checkInAt) {
    return NextResponse.json({ error: "The visit check-in GPS point is incomplete." }, { status: 422 });
  }
  if (!validPoint(completionPoint) || !completionAt) {
    return NextResponse.json({ error: "The visit completion GPS point is incomplete." }, { status: 422 });
  }
  if (new Date(completionAt) < new Date(checkInAt)) {
    return NextResponse.json({ error: "Visit completion cannot be earlier than check-in." }, { status: 422 });
  }

  const date = workDate(new Date(checkInAt));
  const attendance = (await db.listRows({
    databaseId,
    tableId: "attendance_records",
    queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.limit(1)],
  })).rows[0];
  if (!attendance) return NextResponse.json({ error: "Check in for your shift first." }, { status: 409 });
  const allowedClockSkewMs = 5 * 60 * 1000;
  const attendanceStart = new Date(String(attendance.check_in_at)).valueOf();
  const attendanceEnd = attendance.check_out_at ? new Date(String(attendance.check_out_at)).valueOf() : null;
  if (new Date(checkInAt).valueOf() + allowedClockSkewMs < attendanceStart
    || (attendanceEnd !== null && new Date(completionAt).valueOf() - allowedClockSkewMs > attendanceEnd)) {
    return NextResponse.json({ error: "The visit must be captured during the active work shift." }, { status: 409 });
  }

  const [checkInTerritory, completionTerritory] = await Promise.all([
    territoryAccessForEmployee(db, actor.employee.$id, new Date(checkInAt)),
    territoryAccessForEmployee(db, actor.employee.$id, new Date(completionAt)),
  ]);
  const checkInTerritoryDecision = evaluateTerritoryAccess(checkInTerritory, checkInPoint);
  if (!checkInTerritoryDecision.allowed) return NextResponse.json({ error: checkInTerritoryDecision.reason }, { status: 403 });
  const completionTerritoryDecision = evaluateTerritoryAccess(completionTerritory, completionPoint);
  if (!completionTerritoryDecision.allowed) return NextResponse.json({ error: completionTerritoryDecision.reason }, { status: 403 });

  let assignment: DataRow | null = null;
  let outletPoint = { latitude: checkInPoint.latitude, longitude: checkInPoint.longitude };
  if (!selfInitiated) {
    const routeId = existing?.route_assignment_id ? String(existing.route_assignment_id) : text(form.get("routeId"), 36);
    assignment = routeId
      ? await db.getRow({ databaseId, tableId: "route_assignments", rowId: routeId }).then((row) => row as DataRow).catch(() => null)
      : (await db.listRows({
        databaseId,
        tableId: "route_assignments",
        queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("outlet_id", requestedOutletId), Query.equal("work_date", date), Query.limit(1)],
      })).rows[0] as DataRow ?? null;
    if (!assignment || assignment.employee_id !== actor.employee.$id || assignment.outlet_id !== requestedOutletId || assignment.work_date !== date) {
      return NextResponse.json({ error: "This visit is not assigned to you for this date." }, { status: 403 });
    }
    const outlet = await db.getRow({ databaseId, tableId: "outlets", rowId: requestedOutletId });
    outletPoint = { latitude: Number(outlet.latitude), longitude: Number(outlet.longitude) };
  }
  const checkInGeofence = evaluateGeofence(outletPoint, checkInPoint, 70, 0);
  if (!checkInGeofence.accepted) {
    return NextResponse.json({ error: `Move closer to the visit location. Check-in was ${checkInGeofence.distanceMeters} m away; the maximum is 70 m.` }, { status: 422 });
  }
  const completionGeofence = evaluateGeofence(outletPoint, completionPoint, 70, 0);
  if (!completionGeofence.accepted) {
    return NextResponse.json({ error: `Return to the visit point. Completion was ${completionGeofence.distanceMeters} m away; the maximum is 70 m.` }, { status: 422 });
  }

  const rowId = existing?.$id ?? visitId;
  const storage = createAdminStorage();
  const uploads = [["photo", photo], ["audio", audio]] as const;
  for (const [kind, value] of uploads) {
    const evidenceId = stableId("evidence", `${rowId}:${kind}`);
    try {
      await storage.createFile({
        bucketId,
        fileId: evidenceId,
        file: InputFile.fromBuffer(Buffer.from(await value.arrayBuffer()), safeName(value.name, `${kind}-${rowId}`)),
        permissions: [],
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  const now = new Date().toISOString();
  const outletId = selfInitiated ? rowId : requestedOutletId;
  const completeData = {
    check_out_at: completionAt,
    outcome: text(form.get("outcome"), 48) || "Visit completed",
    notes: text(form.get("notes"), 4000),
    completion_distance_m: completionGeofence.distanceMeters,
    status: "completed",
  };
  for (const [kind, value] of uploads) {
    const evidenceId = stableId("evidence", `${rowId}:${kind}`);
    try {
      await db.createRow({ databaseId, tableId: "visit_evidence", rowId: evidenceId, data: {
        visit_id: rowId,
        employee_id: actor.employee.$id,
        outlet_id: outletId,
        type: kind,
        file_id: evidenceId,
        filename: safeName(value.name, `${kind}-${rowId}`),
        mime_type: value.type,
        captured_at: completionAt,
        latitude: completionPoint.latitude,
        longitude: completionPoint.longitude,
        accuracy: completionPoint.accuracy,
      }, permissions: [] });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  // A server-visible visit is created or marked complete only after both files and
  // their evidence rows exist. Retries use stable IDs, so partial infrastructure
  // failures cannot produce duplicate evidence or an evidence-less visit record.
  if (existing) {
    await db.updateRow({ databaseId, tableId: "visits", rowId, data: completeData });
  } else {
    await db.createRow({ databaseId, tableId: "visits", rowId, data: {
      employee_id: actor.employee.$id,
      outlet_id: outletId,
      ...(assignment ? { route_assignment_id: assignment.$id } : {}),
      visit_type: selfInitiated ? "self_initiated" : "assigned",
      ...(customerName ? { customer_name: customerName } : {}),
      ...(customerAddress ? { customer_address: customerAddress } : {}),
      work_date: date,
      check_in_at: checkInAt,
      latitude: checkInPoint.latitude,
      longitude: checkInPoint.longitude,
      coordinates: [checkInPoint.longitude, checkInPoint.latitude],
      accuracy: checkInPoint.accuracy,
      geofence_distance_m: checkInGeofence.distanceMeters,
      geofence_accepted: true,
      idempotency_key: idempotencyKey,
      device_captured_at: checkInAt,
      ...completeData,
    }, permissions: [] });
  }

  const locationPoints = [
    { key: "check-in", capturedAt: checkInAt, latitude: checkInPoint.latitude, longitude: checkInPoint.longitude, accuracy: checkInPoint.accuracy, source: "visit_check_in" },
    { key: "check-out", capturedAt: completionAt, latitude: completionPoint.latitude, longitude: completionPoint.longitude, accuracy: completionPoint.accuracy, source: "visit_check_out" },
  ];
  for (const point of locationPoints) {
    try {
      await db.createRow({ databaseId, tableId: "location_points", rowId: stableId("location", `${rowId}:${point.key}`), data: {
        employee_id: actor.employee.$id,
        visit_id: rowId,
        captured_at: point.capturedAt,
        received_at: now,
        latitude: point.latitude,
        longitude: point.longitude,
        coordinates: [point.longitude, point.latitude],
        accuracy: point.accuracy,
        source: point.source,
        work_date: date,
      }, permissions: [] });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }

  if (assignment) {
    await db.updateRow({
      databaseId,
      tableId: "route_assignments",
      rowId: assignment.$id,
      data: { status: "completed", completed_at: now },
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, visitId: rowId, evidenceCount: 2 }, { status: existing ? 200 : 201 });
}
