import { createHash, randomUUID } from "node:crypto";
import { ID, Query, type Models } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { hasRequiredVisitEvidence, MAX_PLACE_MARK_ACCURACY_METERS, parseTerritoryBoundary, pointInTerritory } from "@fieldops/domain";
import { requireDashboardAdmin } from "../../../../lib/auth";
import { number, text } from "../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
type DataRow = Models.Row & Record<string, unknown>;

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && Number(error.code) === 404;
}

function fieldOutletCode(visitId: string) {
  return `UV-${createHash("sha256").update(visitId).digest("hex").slice(0, 10).toUpperCase()}`;
}

async function rollback(db: ReturnType<typeof createAdminTablesDb>, transactionId: string) {
  await db.updateTransaction({ transactionId, rollback: true }).catch(() => undefined);
}

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const visitId = text(body.visitId, 36);
  const action = text(body.action, 16);
  if (!visitId || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "Visit and review action are required." }, { status: 400 });
  }

  const db = createAdminTablesDb();
  let visit: DataRow;
  try {
    visit = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }) as DataRow;
  } catch (error) {
    if (isNotFound(error)) return NextResponse.json({ error: "The marked place no longer exists." }, { status: 404 });
    throw error;
  }
  const selfInitiated = visit.visit_type === "self_initiated" || !visit.route_assignment_id;
  if (!selfInitiated || visit.status !== "completed") {
    return NextResponse.json({ error: "Only completed salesperson-marked visits can become permanent places." }, { status: 409 });
  }

  const evidence = await db.listRows({
    databaseId,
    tableId: "visit_evidence",
    queries: [Query.equal("visit_id", visitId), Query.limit(10)],
  });
  const evidenceTypes = new Set(evidence.rows.map((item) => String(item.type)));
  if (!hasRequiredVisitEvidence({ photo: evidenceTypes.has("photo") || undefined, audio: evidenceTypes.has("audio") || undefined })) {
    return NextResponse.json({ error: "Photo and voice evidence must be stored before this place can be reviewed." }, { status: 409 });
  }

  const currentStatus = text(visit.place_approval_status, 24) || "pending_review";
  const now = new Date().toISOString();
  if (action === "reject") {
    const reason = text(body.reason, 1000);
    if (!reason) return NextResponse.json({ error: "Add a short reason so the salesperson knows what needs correction." }, { status: 400 });
    if (currentStatus === "approved") return NextResponse.json({ error: "This place is already approved. Correct its saved name instead." }, { status: 409 });
    if (currentStatus === "rejected") return NextResponse.json({ ok: true, visitId, placeApprovalStatus: "rejected" });

    const transaction = await db.createTransaction({ ttl: 60 });
    try {
      await db.updateRow({ databaseId, tableId: "visits", rowId: visitId, transactionId: transaction.$id, data: {
        place_approval_status: "rejected",
        reviewed_by: actor.user.$id,
        reviewed_at: now,
        review_note: reason,
      } });
      await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), transactionId: transaction.$id, data: {
        actor_user_id: actor.user.$id,
        action: "place.rejected",
        entity_type: "visit",
        entity_id: visitId,
        occurred_at: now,
        before_json: JSON.stringify({ placeApprovalStatus: currentStatus }),
        after_json: JSON.stringify({ placeApprovalStatus: "rejected", reason }),
        reason: "Management place review",
        correlation_id: randomUUID(),
      }, permissions: [] });
      await db.updateTransaction({ transactionId: transaction.$id, commit: true });
      return NextResponse.json({ ok: true, visitId, placeApprovalStatus: "rejected" });
    } catch (error) {
      await rollback(db, transaction.$id);
      const latest = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }).catch(() => null);
      if (latest?.place_approval_status === "rejected") {
        return NextResponse.json({ ok: true, visitId, placeApprovalStatus: "rejected" });
      }
      if (latest?.place_approval_status === "approved") {
        return NextResponse.json({ error: "This place was already approved in another tab or request. Refresh the review queue." }, { status: 409 });
      }
      throw error;
    }
  }

  const officialName = text(body.name, 160);
  const territoryId = text(body.territoryId, 36);
  const address = text(body.address, 500) || text(visit.customer_address, 500) || "Address recorded at the verified GPS point";
  const latitude = number(visit.latitude), longitude = number(visit.longitude), accuracy = number(visit.accuracy);
  if (!officialName || !territoryId || latitude === null || longitude === null) {
    return NextResponse.json({ error: "Official place name, territory, and a valid marked point are required." }, { status: 400 });
  }
  if (accuracy === null || accuracy < 0 || accuracy > MAX_PLACE_MARK_ACCURACY_METERS) {
    return NextResponse.json({ error: "This point has a weak GPS reading and cannot become permanent. Ask the salesperson to mark it again near the shop entrance after the accuracy number improves." }, { status: 409 });
  }
  if (currentStatus === "rejected") {
    return NextResponse.json({ error: "This submission was rejected and cannot be approved without a new review request." }, { status: 409 });
  }
  if (currentStatus === "approved") {
    return NextResponse.json({ ok: true, visitId, outletId: String(visit.approved_outlet_id || visitId), placeApprovalStatus: "approved" });
  }

  const territory = await db.getRow({ databaseId, tableId: "territories", rowId: territoryId }).catch(() => null);
  const boundary = territory && territory.active === true ? parseTerritoryBoundary(territory.boundary) : null;
  if (!territory || !boundary) {
    return NextResponse.json({ error: "Choose an active territory with a saved map boundary." }, { status: 409 });
  }
  if (!pointInTerritory({ latitude, longitude }, boundary)) {
    return NextResponse.json({ error: `The salesperson's verified point is outside ${String(territory.name)}. Choose the territory containing this point.` }, { status: 422 });
  }

  const outletId = visitId;
  const transaction = await db.createTransaction({ ttl: 60 });
  try {
    await db.createRow({ databaseId, tableId: "outlets", rowId: outletId, transactionId: transaction.$id, data: {
      code: fieldOutletCode(visitId),
      name: officialName,
      address,
      latitude,
      longitude,
      coordinates: [longitude, latitude],
      status: "active",
      territory_id: territoryId,
      assigned_employee_id: String(visit.employee_id),
      visit_frequency: "on_demand",
      notes: "Approved from a salesperson-marked visit with photo and voice evidence.",
      created_by: actor.user.$id,
      origin_visit_id: visitId,
      source: "salesperson_mark",
    }, permissions: [] });
    await db.updateRow({ databaseId, tableId: "visits", rowId: visitId, transactionId: transaction.$id, data: {
      place_approval_status: "approved",
      candidate_territory_id: territoryId,
      approved_outlet_id: outletId,
      reviewed_by: actor.user.$id,
      reviewed_at: now,
      review_note: text(body.reason, 1000),
    } });
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), transactionId: transaction.$id, data: {
      actor_user_id: actor.user.$id,
      action: "place.approved",
      entity_type: "outlet",
      entity_id: outletId,
      occurred_at: now,
      before_json: JSON.stringify({ submittedName: text(visit.customer_name, 160), placeApprovalStatus: currentStatus }),
      after_json: JSON.stringify({ officialName, territoryId, latitude, longitude, originVisitId: visitId }),
      reason: "Management approved a salesperson-marked place",
      correlation_id: randomUUID(),
    }, permissions: [] });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    return NextResponse.json({ ok: true, visitId, outletId, placeApprovalStatus: "approved" }, { status: 201 });
  } catch (error) {
    await rollback(db, transaction.$id);
    const latest = await db.getRow({ databaseId, tableId: "visits", rowId: visitId }).catch(() => null);
    if (latest?.place_approval_status === "approved") {
      return NextResponse.json({ ok: true, visitId, outletId: String(latest.approved_outlet_id || visitId), placeApprovalStatus: "approved" });
    }
    throw error;
  }
}
