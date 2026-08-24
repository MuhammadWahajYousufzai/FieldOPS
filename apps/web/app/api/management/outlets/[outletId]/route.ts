import { randomUUID } from "node:crypto";
import { ID } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireManager } from "../../../../../lib/auth";
import { text } from "../../../../../lib/mobile-auth";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

export async function PATCH(request: Request, context: { params: Promise<{ outletId: string }> }) {
  const actor = await requireManager();
  if (!actor) return NextResponse.json({ error: "Manager access is required." }, { status: 403 });

  const { outletId } = await context.params;
  const body = await request.json().catch(() => ({}));
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
      return NextResponse.json({ error: "Another manager changed this name. Refresh the page before applying your correction." }, { status: 409 });
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
    if (status === 409) return NextResponse.json({ error: "Another manager changed this place. Refresh the page and try again." }, { status: 409 });
    throw error;
  }
}
