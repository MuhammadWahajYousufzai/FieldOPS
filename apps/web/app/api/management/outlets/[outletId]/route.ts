import { randomUUID } from "node:crypto";
import { parseTerritoryBoundary, pointInTerritory } from "@fieldops/domain";
import { ID, Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../../lib/auth";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  managementAuditIdentity,
  managementOperationKey,
  optimisticWriteDecision,
} from "../../../../../lib/management-write";
import { text } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function PATCH(request: Request, context: { params: Promise<{ outletId: string }> }) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });

  const { outletId } = await context.params;
  const body = await request.json().catch(() => ({}));
  if (body.mode === "metadata") return updateOutletMetadata(outletId, body, actor.user.$id);
  const name = text(body.name, 160);
  const expectedName = text(body.expectedName, 160);
  if (!name || !expectedName) return NextResponse.json({ error: "Enter the corrected name and refresh the current place record." }, { status: 400 });

  const db = createAdminTablesDb();
  const transaction = await db.createTransaction({ ttl: 60 });
  const now = new Date().toISOString();
  try {
    const outlet = await db.getRow({ databaseId, tableId: "outlets", rowId: outletId, transactionId: transaction.$id });
    if (!outlet.origin_visit_id || outlet.source !== "salesperson_mark") {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ error: "Use the outlet editor for management-created places." }, { status: 409 });
    }
    if (String(outlet.name) !== expectedName) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ error: "This name changed in another tab or request. Refresh before applying your correction." }, { status: 409 });
    }
    if (String(outlet.name) === name) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ ok: true, outletId, name });
    }
    await db.updateRow({ databaseId, tableId: "outlets", rowId: outletId, transactionId: transaction.$id, data: { name } });
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: ID.unique(), transactionId: transaction.$id, data: {
      actor_user_id: actor.user.$id,
      action: "outlet.name_corrected",
      entity_type: "outlet",
      entity_id: outletId,
      occurred_at: now,
      before_json: JSON.stringify({ name: String(outlet.name) }),
      after_json: JSON.stringify({ name, latitude: outlet.latitude, longitude: outlet.longitude }),
      reason: text(body.reason, 1000) || "Management corrected the official place name; verified GPS point unchanged",
      correlation_id: randomUUID(),
    }, permissions: [] });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    return NextResponse.json({ ok: true, outletId, name });
  } catch (error) {
    await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
    const status = typeof error === "object" && error !== null && "code" in error ? Number(error.code) : 0;
    if (status === 404) return NextResponse.json({ error: "The saved place was not found." }, { status: 404 });
    if (status === 409) return NextResponse.json({ error: "This place changed in another tab or request. Refresh the page and try again." }, { status: 409 });
    throw error;
  }
}

async function updateOutletMetadata(outletId: string, body: Record<string, unknown>, actorUserId: string) {
  const name = text(body.name, 160);
  const address = text(body.address, 500);
  const notes = text(body.notes, 4000);
  const territoryId = text(body.territoryId, 36);
  const expectedUpdatedAt = text(body.expectedUpdatedAt, 40);
  if (!name || !address || !territoryId || !expectedUpdatedAt) {
    return NextResponse.json({ error: "Name, address, territory, and the current record version are required." }, { status: 400 });
  }

  const db = createAdminTablesDb();
  const after = { name, address, notes, territoryId };
  const transaction = await db.createTransaction({ ttl: 60 });
  try {
    const [outlet, territory] = await Promise.all([
      getRowOrNull(db, "outlets", outletId, transaction.$id),
      getRowOrNull(db, "territories", territoryId, transaction.$id),
    ]);
    if (!outlet) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ error: "The outlet was not found." }, { status: 404 });
    }
    const boundary = territory?.active === true ? parseTerritoryBoundary(territory.boundary) : null;
    if (!territory || !boundary) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ error: "Choose an active territory with a saved boundary." }, { status: 409 });
    }
    const latitude = Number(outlet.latitude), longitude = Number(outlet.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !pointInTerritory({ latitude, longitude }, boundary)) {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      return NextResponse.json({ error: `This outlet's locked GPS point is outside ${String(territory.name)}. Redraw the correct boundary or choose the territory containing the point.` }, { status: 422 });
    }

    const before = outletMetadata(outlet);
    const decision = optimisticWriteDecision(
      expectedUpdatedAt,
      outlet.$updatedAt,
      sameOutletMetadata(before, after),
    );
    if (decision !== "write") {
      await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
      if (decision === "replay") {
        return NextResponse.json({ ok: true, outletId, updatedAt: outlet.$updatedAt, changed: false, replayed: true });
      }
      return outletMetadataConflictResponse();
    }

    const now = new Date().toISOString();
    const operationKey = managementOperationKey(body.operationId, "outlet.metadata", outletId, expectedUpdatedAt, after);
    const { auditId, correlationId } = managementAuditIdentity("outlet.metadata_updated", outletId, operationKey);
    await db.updateRow({
      databaseId,
      tableId: "outlets",
      rowId: outletId,
      transactionId: transaction.$id,
      data: { name, address, notes, territory_id: territoryId },
    });
    await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId: transaction.$id, data: {
      actor_user_id: actorUserId,
      action: "outlet.metadata_updated",
      entity_type: "outlet",
      entity_id: outletId,
      occurred_at: now,
      before_json: JSON.stringify(before),
      after_json: JSON.stringify({ ...after, latitude, longitude }),
      reason: "Management updated outlet metadata; saved GPS point unchanged",
      correlation_id: correlationId,
    }, permissions: [] });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    const updated = await db.getRow({ databaseId, tableId: "outlets", rowId: outletId });
    return NextResponse.json({ ok: true, outletId, updatedAt: updated.$updatedAt, changed: true, replayed: false });
  } catch (error) {
    await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
    if (isAppwriteConflict(error)) {
      const current = await getRowOrNull(db, "outlets", outletId).catch(() => null);
      if (current && sameOutletMetadata(outletMetadata(current), after)) {
        return NextResponse.json({ ok: true, outletId, updatedAt: current.$updatedAt, changed: false, replayed: true });
      }
      return outletMetadataConflictResponse();
    }
    if (isAppwriteNotFound(error)) {
      const current = await getRowOrNull(db, "outlets", outletId).catch(() => null);
      return current
        ? NextResponse.json({ error: "Choose an active territory with a saved boundary." }, { status: 409 })
        : NextResponse.json({ error: "The outlet was not found." }, { status: 404 });
    }
    return NextResponse.json({
      error: "The outlet could not be updated. No partial change was applied; retrying is safe.",
    }, { status: 500 });
  }
}

function outletMetadata(outlet: Record<string, unknown>) {
  return {
    name: String(outlet.name),
    address: String(outlet.address),
    notes: String(outlet.notes || ""),
    territoryId: String(outlet.territory_id),
  };
}

function sameOutletMetadata(
  current: ReturnType<typeof outletMetadata>,
  requested: ReturnType<typeof outletMetadata>,
) {
  return current.name === requested.name
    && current.address === requested.address
    && current.notes === requested.notes
    && current.territoryId === requested.territoryId;
}

async function getRowOrNull(
  db: ReturnType<typeof createAdminTablesDb>,
  tableId: string,
  rowId: string,
  transactionId?: string,
) {
  try {
    return await db.getRow({ databaseId, tableId, rowId, ...(transactionId ? { transactionId } : {}) });
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

function outletMetadataConflictResponse() {
  return NextResponse.json({
    error: "This outlet changed in another tab or request. Refresh before saving again.",
    code: "outlet_metadata_changed",
  }, { status: 409 });
}
