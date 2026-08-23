import { createHash } from "node:crypto";
import { Models, Query } from "node-appwrite";
import { InputFile } from "node-appwrite/file";
import { NextResponse } from "next/server";
import {
  evaluateGeofence,
  visitEvidenceExtension,
  visitEvidenceValidationError,
  type VisitEvidenceKind,
} from "@fieldops/domain";
import { createAdminStorage, createAdminTablesDb } from "@fieldops/appwrite/server";
import { mobileActor, number, text, workDate } from "../../../../../lib/mobile-auth";
import { evaluateTerritoryAccess, territoryAccessForEmployee } from "../../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID?.trim() || "visit-evidence";
const INCOMPLETE_FILE_STALE_MS = 2 * 60 * 1000;
type DataRow = Models.Row & Record<string, unknown>;

const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

function safeEvidenceName(name: string, fallbackStem: string, extension: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  const stem = cleaned.replace(/\.[^.]*$/, "").replace(/[.-]+$/, "").slice(0, 120 - extension.length);
  const safeStem = stem || fallbackStem.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120 - extension.length);
  return `${safeStem}${extension}`;
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

function storedFileMatches(
  stored: Models.File,
  expected: { evidenceId: string; size: number; signature: string },
) {
  return stored.$id === expected.evidenceId
    && stored.bucketId === bucketId
    && stored.chunksUploaded === stored.chunksTotal
    && stored.sizeOriginal === expected.size
    && stored.signature.toLowerCase() === expected.signature;
}

function isExactIncompleteFile(stored: Models.File, evidenceId: string) {
  const updatedAt = new Date(stored.$updatedAt).valueOf();
  return stored.$id === evidenceId
    && stored.bucketId === bucketId
    && stored.chunksUploaded < stored.chunksTotal
    && Number.isFinite(updatedAt)
    && Date.now() - updatedAt >= INCOMPLETE_FILE_STALE_MS;
}

function sameFileSnapshot(left: Models.File, right: Models.File) {
  return left.$id === right.$id
    && left.bucketId === right.bucketId
    && left.$createdAt === right.$createdAt
    && left.$updatedAt === right.$updatedAt
    && left.chunksUploaded === right.chunksUploaded
    && left.chunksTotal === right.chunksTotal;
}

async function ensureEvidenceFile(
  storage: ReturnType<typeof createAdminStorage>,
  upload: { evidenceId: string; buffer: Buffer; filename: string; size: number; signature: string },
) {
  const createFile = () => storage.createFile({
    bucketId,
    fileId: upload.evidenceId,
    file: InputFile.fromBuffer(upload.buffer, upload.filename),
    permissions: [],
  });

  try {
    return storedFileMatches(await createFile(), upload);
  } catch (error) {
    if (!isConflict(error)) throw error;
  }

  let stored: Models.File | null;
  try {
    stored = await storage.getFile({ bucketId, fileId: upload.evidenceId });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    stored = null;
  }
  if (stored && storedFileMatches(stored, upload)) return true;
  if (stored) {
    if (!isExactIncompleteFile(stored, upload.evidenceId)) return false;

    // Wait beyond the site request limit, then re-read immediately before
    // deletion so an active concurrent upload is never replaced.
    let latest: Models.File | null;
    try {
      latest = await storage.getFile({ bucketId, fileId: upload.evidenceId });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      latest = null;
    }
    if (latest && storedFileMatches(latest, upload)) return true;
    if (latest) {
      if (!isExactIncompleteFile(latest, upload.evidenceId) || !sameFileSnapshot(stored, latest)) return false;
      try {
        await storage.deleteFile({ bucketId, fileId: upload.evidenceId });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  // Retry exactly once. If another request wins the race, verify its completed
  // deterministic file instead of attempting another delete or upload.
  try {
    return storedFileMatches(await createFile(), upload);
  } catch (error) {
    if (!isConflict(error)) throw error;
    try {
      return storedFileMatches(
        await storage.getFile({ bucketId, fileId: upload.evidenceId }),
        upload,
      );
    } catch (getError) {
      if (!isNotFound(getError)) throw getError;
      return false;
    }
  }
}

function evidenceRowMatches(
  row: DataRow,
  expected: { evidenceId: string; visitId: string; employeeId: string; outletId: string; kind: VisitEvidenceKind },
) {
  return row.$id === expected.evidenceId
    && String(row.visit_id) === expected.visitId
    && String(row.employee_id) === expected.employeeId
    && String(row.outlet_id) === expected.outletId
    && String(row.type) === expected.kind
    && String(row.file_id) === expected.evidenceId;
}

function locationRowMatches(
  row: DataRow,
  expected: { locationId: string; visitId: string; employeeId: string; source: string },
) {
  return row.$id === expected.locationId
    && String(row.visit_id) === expected.visitId
    && String(row.employee_id) === expected.employeeId
    && String(row.source) === expected.source;
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
  if (!(photo instanceof File) || !(audio instanceof File)) {
    return NextResponse.json({ error: "A visit photo and audio note are both required." }, { status: 422 });
  }
  const evidenceError = visitEvidenceValidationError("photo", photo)
    ?? visitEvidenceValidationError("audio", audio);
  if (evidenceError) {
    return NextResponse.json({ error: evidenceError }, { status: 422 });
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
  if (existing && text(existing.idempotency_key, 64) && text(existing.idempotency_key, 64) !== idempotencyKey) {
    return NextResponse.json({ error: "This visit was created by a different submission." }, { status: 409 });
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
  const attendanceRows = (await db.listRows({
    databaseId,
    tableId: "attendance_records",
    queries: [Query.equal("employee_id", actor.employee.$id), Query.equal("work_date", date), Query.limit(100)],
  })).rows;
  if (attendanceRows.length === 0) return NextResponse.json({ error: "Start a work session before recording a visit." }, { status: 409 });
  const allowedClockSkewMs = 5 * 60 * 1000;
  const visitStart = new Date(checkInAt).valueOf(), visitEnd = new Date(completionAt).valueOf();
  const matchingSession = attendanceRows.find((attendance) => {
    const attendanceStart = new Date(String(attendance.check_in_at)).valueOf();
    const attendanceEnd = attendance.check_out_at ? new Date(String(attendance.check_out_at)).valueOf() : null;
    return visitStart + allowedClockSkewMs >= attendanceStart
      && (attendanceEnd === null || visitEnd - allowedClockSkewMs <= attendanceEnd);
  });
  if (!matchingSession) {
    return NextResponse.json({ error: "The visit must be captured during one of today’s work sessions." }, { status: 409 });
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
  const uploads = await Promise.all(([["photo", photo], ["audio", audio]] as const).map(async ([kind, value]) => {
    const buffer = Buffer.from(await value.arrayBuffer());
    const evidenceId = stableId("evidence", `${rowId}:${kind}`);
    return {
      kind,
      value,
      buffer,
      size: buffer.length,
      evidenceId,
      filename: safeEvidenceName(value.name, `${kind}-${rowId}`, visitEvidenceExtension(kind, value.type)),
      signature: createHash("md5").update(buffer).digest("hex"),
    };
  }));
  for (const upload of uploads) {
    if (!(await ensureEvidenceFile(storage, upload))) {
      return NextResponse.json({ error: `Stored ${upload.kind} evidence conflicts with this submission.` }, { status: 409 });
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
  for (const upload of uploads) {
    try {
      await db.createRow({ databaseId, tableId: "visit_evidence", rowId: upload.evidenceId, data: {
        visit_id: rowId,
        employee_id: actor.employee.$id,
        outlet_id: outletId,
        type: upload.kind,
        file_id: upload.evidenceId,
        filename: upload.filename,
        mime_type: upload.value.type,
        captured_at: completionAt,
        latitude: completionPoint.latitude,
        longitude: completionPoint.longitude,
        accuracy: completionPoint.accuracy,
      }, permissions: [] });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const stored = await db.getRow({ databaseId, tableId: "visit_evidence", rowId: upload.evidenceId }) as DataRow;
      if (!evidenceRowMatches(stored, {
        evidenceId: upload.evidenceId,
        visitId: rowId,
        employeeId: actor.employee.$id,
        outletId,
        kind: upload.kind,
      })) {
        return NextResponse.json({ error: `Stored ${upload.kind} evidence belongs to another visit.` }, { status: 409 });
      }
    }
  }

  // A server-visible visit is created or marked complete only after both files and
  // their evidence rows exist. Retries use stable IDs, so partial infrastructure
  // failures cannot produce duplicate evidence or an evidence-less visit record.
  if (existing) {
    await db.updateRow({ databaseId, tableId: "visits", rowId, data: completeData });
  } else {
    const createData = {
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
    };
    try {
      await db.createRow({ databaseId, tableId: "visits", rowId, data: createData, permissions: [] });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const competing = await db.getRow({ databaseId, tableId: "visits", rowId }) as DataRow;
      if (competing.$id !== rowId
        || String(competing.employee_id) !== actor.employee.$id
        || String(competing.idempotency_key) !== idempotencyKey) {
        return NextResponse.json({ error: "The visit ID is already used by another submission." }, { status: 409 });
      }
      await db.updateRow({ databaseId, tableId: "visits", rowId, data: completeData });
    }
  }

  const locationPoints = [
    { key: "check-in", capturedAt: checkInAt, latitude: checkInPoint.latitude, longitude: checkInPoint.longitude, accuracy: checkInPoint.accuracy, source: "visit_check_in" },
    { key: "check-out", capturedAt: completionAt, latitude: completionPoint.latitude, longitude: completionPoint.longitude, accuracy: completionPoint.accuracy, source: "visit_check_out" },
  ];
  for (const point of locationPoints) {
    const locationId = stableId("location", `${rowId}:${point.key}`);
    try {
      await db.createRow({ databaseId, tableId: "location_points", rowId: locationId, data: {
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
      const stored = await db.getRow({ databaseId, tableId: "location_points", rowId: locationId }) as DataRow;
      if (!locationRowMatches(stored, {
        locationId,
        visitId: rowId,
        employeeId: actor.employee.$id,
        source: point.source,
      })) {
        return NextResponse.json({ error: "Stored visit location belongs to another submission." }, { status: 409 });
      }
    }
  }

  if (assignment) {
    await db.updateRow({
      databaseId,
      tableId: "route_assignments",
      rowId: assignment.$id,
      data: { status: "completed", completed_at: completionAt },
    });
  }
  return NextResponse.json({ ok: true, visitId: rowId, evidenceCount: 2 }, { status: existing ? 200 : 201 });
}
