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
import { mobileActor, number, text } from "../../../../../../lib/mobile-auth";
import { evaluateTerritoryAccess, territoryAccessForEmployee } from "../../../../../../lib/territory-access";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID?.trim() || "visit-evidence";
const INCOMPLETE_FILE_STALE_MS = 2 * 60 * 1000;
type DataRow = Models.Row & Record<string, unknown>;

function safeEvidenceName(name: string, fallbackStem: string, extension: string) {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  const stem = cleaned.replace(/\.[^.]*$/, "").replace(/[.-]+$/, "").slice(0, 120 - extension.length);
  const safeStem = stem || fallbackStem.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120 - extension.length);
  return `${safeStem}${extension}`;
}

const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

function isConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === 409;
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === 404;
}

function isoDate(value: unknown) {
  const parsed = new Date(String(value ?? ""));
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

export async function POST(request: Request, context: { params: Promise<{ visitId: string }> }) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { visitId } = await context.params;
  const db = createAdminTablesDb();
  let visit: DataRow;
  try { visit = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }) as DataRow; } catch { return NextResponse.json({ error: "Visit not found." }, { status: 404 }); }
  if (visit.employee_id !== actor.employee.$id) return NextResponse.json({ error: "This visit belongs to another salesperson." }, { status: 403 });
  const form = await request.formData();
  const point = {
    latitude: number(form.get("latitude")) ?? number(visit.latitude),
    longitude: number(form.get("longitude")) ?? number(visit.longitude),
    accuracy: number(form.get("accuracy")) ?? number(visit.accuracy),
  };
  const capturedAt = isoDate(text(form.get("capturedAt"), 40) || visit.check_out_at || new Date().toISOString());
  const now = new Date().toISOString();
  const photo = form.get("photo"), audio = form.get("audio");
  if (!(photo instanceof File) || !(audio instanceof File)) {
    return NextResponse.json({ error: "A visit photo and audio note are both required." }, { status: 422 });
  }
  const evidenceError = visitEvidenceValidationError("photo", photo)
    ?? visitEvidenceValidationError("audio", audio);
  if (evidenceError) return NextResponse.json({ error: evidenceError }, { status: 422 });
  if (!validPoint(point) || !capturedAt) {
    return NextResponse.json({ error: "The visit completion GPS point is incomplete." }, { status: 422 });
  }
  const { latitude, longitude, accuracy } = point;
  const selfInitiated = visit.visit_type === "self_initiated" || !visit.route_assignment_id;
  const territoryDecision = evaluateTerritoryAccess(
    await territoryAccessForEmployee(db, actor.employee.$id, new Date(capturedAt)),
    { latitude, longitude },
  );
  if (!territoryDecision.allowed) return NextResponse.json({ error: territoryDecision.reason }, { status: 403 });
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
  const storage = createAdminStorage();
  const uploads = await Promise.all(([["photo", photo], ["audio", audio]] as const).map(async ([kind, value]) => {
    const buffer = Buffer.from(await value.arrayBuffer());
    const evidenceId = stableId("evidence", `${visitId}:${kind}`);
    return {
      kind,
      value,
      buffer,
      size: buffer.length,
      evidenceId,
      filename: safeEvidenceName(value.name, `${kind}-${visitId}`, visitEvidenceExtension(kind, value.type)),
      signature: createHash("md5").update(buffer).digest("hex"),
    };
  }));
  for (const upload of uploads) {
    if (!(await ensureEvidenceFile(storage, upload))) {
      return NextResponse.json({ error: `Stored ${upload.kind} evidence conflicts with this submission.` }, { status: 409 });
    }
  }
  for (const upload of uploads) {
    try { await db.createRow({ databaseId, tableId: "visit_evidence", rowId: upload.evidenceId, data: {
      visit_id: visitId, employee_id: actor.employee.$id, outlet_id: String(visit.outlet_id), type: upload.kind,
      file_id: upload.evidenceId, filename: upload.filename, mime_type: upload.value.type,
      captured_at: capturedAt, latitude, longitude, accuracy,
    }, permissions: [] }); } catch (error) {
      if (!isConflict(error)) throw error;
      const stored = await db.getRow({ databaseId, tableId: "visit_evidence", rowId: upload.evidenceId }) as DataRow;
      if (!evidenceRowMatches(stored, {
        evidenceId: upload.evidenceId,
        visitId,
        employeeId: actor.employee.$id,
        outletId: String(visit.outlet_id),
        kind: upload.kind,
      })) {
        return NextResponse.json({ error: `Stored ${upload.kind} evidence belongs to another visit.` }, { status: 409 });
      }
    }
  }
  const orderAmount = number(form.get("orderAmount"));
  await db.updateRow({ databaseId, tableId: "visits", rowId: visitId, data: {
    check_out_at: capturedAt, outcome: text(form.get("outcome"), 48) || "Visit completed",
    notes: text(form.get("notes"), 4000), ...(orderAmount === null ? {} : { order_amount: orderAmount }),
    completion_distance_m: geofence.distanceMeters, status: "completed",
  } });
  const existingLocations = await db.listRows({
    databaseId,
    tableId: "location_points",
    queries: [Query.equal("visit_id", visitId), Query.limit(100)],
  });
  const locationBelongsToVisit = existingLocations.rows.some((row) => (
    String(row.employee_id) === actor.employee.$id && String(row.source) === "visit_check_out"
  ));
  if (!locationBelongsToVisit) {
    const locationId = stableId("location", `${visitId}:check-out`);
    try {
      await db.createRow({ databaseId, tableId: "location_points", rowId: locationId, data: {
        employee_id: actor.employee.$id, visit_id: visitId, captured_at: capturedAt, received_at: now,
        latitude, longitude, coordinates: [longitude, latitude], accuracy, source: "visit_check_out", work_date: String(visit.work_date),
      }, permissions: [] });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const stored = await db.getRow({ databaseId, tableId: "location_points", rowId: locationId }) as DataRow;
      if (String(stored.visit_id) !== visitId
        || String(stored.employee_id) !== actor.employee.$id
        || String(stored.source) !== "visit_check_out") {
        return NextResponse.json({ error: "Stored visit location belongs to another submission." }, { status: 409 });
      }
    }
  }
  if (visit.route_assignment_id) {
    await db.updateRow({ databaseId, tableId: "route_assignments", rowId: String(visit.route_assignment_id), data: { status: "completed", completed_at: capturedAt } });
  }
  return NextResponse.json({ ok: true, visitId, evidenceCount: 2 });
}
