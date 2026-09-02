import { randomUUID } from "node:crypto";
import { ID } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminStorage, createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../../lib/auth";
import { isAppwriteNotFound } from "../../../../../lib/evidence-retention";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
const bucketId = process.env.APPWRITE_EVIDENCE_BUCKET_ID?.trim() || "visit-evidence";
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

export async function DELETE(_request: Request, context: { params: Promise<{ evidenceId: string }> }) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const { evidenceId } = await context.params;
  if (!safeId.test(evidenceId)) return NextResponse.json({ error: "The evidence record is invalid." }, { status: 400 });

  const db = createAdminTablesDb();
  const storage = createAdminStorage();
  let evidence;
  try {
    evidence = await db.getRow({ databaseId, tableId: "visit_evidence", rowId: evidenceId });
  } catch (error) {
    if (isAppwriteNotFound(error)) return NextResponse.json({ ok: true, alreadyDeleted: true });
    return NextResponse.json({ error: "The evidence record could not be checked. Nothing was deleted." }, { status: 500 });
  }

  const fileId = String(evidence.file_id ?? "");
  if (!safeId.test(fileId)) {
    return NextResponse.json({ error: "This evidence record has an invalid file link. Nothing was deleted." }, { status: 409 });
  }

  try {
    await storage.deleteFile({ bucketId, fileId });
  } catch (error) {
    if (!isAppwriteNotFound(error)) {
      return NextResponse.json({ error: "The media file could not be deleted. The record was kept so the action can be retried safely." }, { status: 502 });
    }
  }

  const transaction = await db.createTransaction({ ttl: 60 });
  try {
    await db.deleteRow({ databaseId, tableId: "visit_evidence", rowId: evidenceId, transactionId: transaction.$id });
    await db.createRow({
      databaseId,
      tableId: "audit_logs",
      rowId: ID.unique(),
      transactionId: transaction.$id,
      data: {
        actor_user_id: actor.user.$id,
        action: "evidence.deleted_by_manager",
        entity_type: "visit_evidence",
        entity_id: evidenceId,
        occurred_at: new Date().toISOString(),
        before_json: JSON.stringify({
          visitId: String(evidence.visit_id ?? ""),
          type: String(evidence.type ?? ""),
          fileId,
          capturedAt: String(evidence.captured_at ?? evidence.$createdAt),
        }),
        after_json: JSON.stringify({ deleted: true }),
        reason: "Manager permanently deleted visit media from the media-retention dashboard",
        correlation_id: randomUUID(),
      },
      permissions: [],
    });
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    return NextResponse.json({ ok: true, evidenceId });
  } catch {
    await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
    return NextResponse.json({
      error: "The file was removed, but its dashboard record still needs cleanup. Retry this same action; it is safe.",
    }, { status: 500 });
  }
}
