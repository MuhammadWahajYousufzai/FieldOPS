import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import { isAppwriteConflict, isAppwriteNotFound, managementAuditIdentity, runManagementTransactionWithRetry, stableManagementId } from "../../../../lib/management-write";
import { number, text } from "../../../../lib/mobile-auth";
import { syncOutletAssignments } from "../../../../lib/outlet-auto-assignment";
import { outletPointAddress } from "../../../../lib/outlet-location";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const name = text(body.name, 160);
  const latitudeInput = number(body.latitude), longitudeInput = number(body.longitude);
  if (!name || latitudeInput === null || longitudeInput === null || Math.abs(latitudeInput) > 90 || Math.abs(longitudeInput) > 180) {
    return NextResponse.json({ error: "Enter the store name and select its location on the map." }, { status: 400 });
  }
  const latitude = Number(latitudeInput.toFixed(6)), longitude = Number(longitudeInput.toFixed(6));
  const outletId = stableManagementId("out", name.toLowerCase(), latitude, longitude);
  const code = `OUT-${outletId.slice(4).toUpperCase()}`;
  const address = text(body.address, 500) || outletPointAddress(latitude, longitude);
  const notes = text(body.notes, 4000);
  const db = createAdminTablesDb();
  try {
    const result = await runManagementTransactionWithRetry(db, async (transactionId) => {
      const existing = await db.getRow({ databaseId, tableId: "outlets", rowId: outletId, transactionId }).catch((error) => {
        if (isAppwriteNotFound(error)) return null;
        throw error;
      });
      if (existing && (existing.status !== "active" || existing.name !== name || existing.address !== address || String(existing.notes || "") !== notes)) {
        return null;
      }
      if (!existing) {
        await db.createRow({ databaseId, tableId: "outlets", rowId: outletId, transactionId, data: {
          code, name, address, latitude, longitude, coordinates: [longitude, latitude],
          status: "active", visit_frequency: "weekly", notes, created_by: actor.user.$id,
        }, permissions: [] });
        const { auditId, correlationId } = managementAuditIdentity("outlet.created", outletId, outletId);
        await db.createRow({ databaseId, tableId: "audit_logs", rowId: auditId, transactionId, data: {
          actor_user_id: actor.user.$id, action: "outlet.created", entity_type: "outlet", entity_id: outletId,
          occurred_at: new Date().toISOString(), after_json: JSON.stringify({ code, name, latitude, longitude }),
          reason: "Management map selection", correlation_id: correlationId,
        }, permissions: [] });
      }
      const [assignment] = await syncOutletAssignments(db, databaseId, actor.user.$id, transactionId, [outletId]);
      return { ...assignment, outletId, created: !existing, replayed: Boolean(existing) };
    });
    if (!result) return NextResponse.json({ error: "An outlet with this name and map point already exists with different details. Edit the saved outlet instead." }, { status: 409 });
    return NextResponse.json({ ok: true, ...result }, { status: result.created ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: isAppwriteConflict(error)
      ? "The outlet plan changed while saving. Please retry."
      : "The outlet could not be saved. No partial outlet or assignment was saved; retrying is safe." }, { status: isAppwriteConflict(error) ? 409 : 500 });
  }
}
