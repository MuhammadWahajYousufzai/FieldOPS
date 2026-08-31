import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import {
  canonicalJson,
  commandReceiptJson,
  commandReceiptMatches,
  dealUpdateData,
  type SalesDealRow,
  validateDealCommand,
} from "../../../../lib/sales-deals";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  runManagementTransactionWithRetry,
  stableManagementId,
} from "../../../../lib/management-write";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

class DealCommandConflict extends Error {}
class DealRecordChanged extends Error {}
class DealRecordNotFound extends Error {}
class ActiveOutletRequired extends Error {}

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action !== "deal_update") {
    return NextResponse.json({ error: "Only deal follow-up updates are available." }, { status: 400 });
  }

  try {
    return await updateDeal(createAdminTablesDb(), actor, body);
  } catch (error) {
    if (error instanceof DealCommandConflict) {
      return NextResponse.json({ error: "This request ID is already attached to different data." }, { status: 409 });
    }
    if (error instanceof DealRecordChanged || isAppwriteConflict(error)) {
      return NextResponse.json({ error: "This deal changed in another tab. Refresh it before saving again." }, { status: 409 });
    }
    if (error instanceof ActiveOutletRequired) {
      return NextResponse.json({ error: "Choose an active customer place." }, { status: 409 });
    }
    if (error instanceof DealRecordNotFound || isAppwriteNotFound(error)) {
      return NextResponse.json({ error: "This deal is no longer available." }, { status: 404 });
    }
    return NextResponse.json({ error: "The deal could not be saved. No partial change was applied; retrying is safe." }, { status: 500 });
  }
}

async function updateDeal(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof requireDashboardAdmin>>>,
  body: Record<string, unknown>,
) {
  const parsed = validateDealCommand({ ...body, action: "update", idempotencyKey: body.operationId ?? body.idempotencyKey });
  if (!parsed.ok || parsed.value.action !== "update") {
    return NextResponse.json({ error: parsed.ok ? "Choose a deal to update." : parsed.error }, { status: 400 });
  }
  const command = parsed.value;
  const receiptId = receiptIdFor(command.idempotencyKey);
  const receiptExpected = {
    actorUserId: actor.user.$id,
    action: "sales.deal_manager_updated",
    entityType: "sales_deal",
    entityId: command.dealId,
    command,
  };

  const outcome = await runManagementTransactionWithRetry(db, async (transactionId) => {
    const receipt = await getRowOrNull(db, "audit_logs", receiptId, transactionId);
    if (receipt) {
      if (!commandReceiptMatches(receipt, receiptExpected)) throw new DealCommandConflict();
      const replayDeal = await getRowOrNull(db, "sales_deals", command.dealId, transactionId);
      if (!replayDeal) throw new DealRecordNotFound();
      return { row: replayDeal, replayed: true };
    }
    const current = await getRowOrNull(db, "sales_deals", command.dealId, transactionId);
    if (!current) throw new DealRecordNotFound();
    if (command.expectedUpdatedAt && current.$updatedAt !== command.expectedUpdatedAt) throw new DealRecordChanged();
    if (command.updates.outletId) await requireActiveOutlet(db, command.updates.outletId, transactionId);
    const row = await db.updateRow({
      databaseId,
      tableId: "sales_deals",
      rowId: command.dealId,
      transactionId,
      data: { ...dealUpdateData(command.updates), updated_by: actor.user.$id },
    });
    await db.createRow({
      databaseId,
      tableId: "audit_logs",
      rowId: receiptId,
      transactionId,
      data: {
        actor_user_id: actor.user.$id,
        action: receiptExpected.action,
        entity_type: receiptExpected.entityType,
        entity_id: command.dealId,
        occurred_at: new Date().toISOString(),
        before_json: canonicalJson({ stage: current.stage, amount: current.amount, nextAction: current.next_action, followUpAt: current.follow_up_at }),
        after_json: commandReceiptJson(command),
        reason: "Updated from the sales pipeline",
        correlation_id: correlationIdFor(command.idempotencyKey),
      },
      permissions: [],
    });
    return { row, replayed: false };
  });
  const committed = await db.getRow({ databaseId, tableId: "sales_deals", rowId: outcome.row.$id });
  return NextResponse.json({
    action: "deal_update",
    ok: true,
    deal: serializeDeal(committed as SalesDealRow),
    changed: !outcome.replayed,
    replayed: outcome.replayed,
  });
}

async function requireActiveOutlet(
  db: ReturnType<typeof createAdminTablesDb>,
  outletId: string,
  transactionId: string,
) {
  const outlet = await getRowOrNull(db, "outlets", outletId, transactionId);
  if (!outlet || outlet.status !== "active") throw new ActiveOutletRequired();
}

async function getRowOrNull(
  db: ReturnType<typeof createAdminTablesDb>,
  tableId: string,
  rowId: string,
  transactionId?: string,
) {
  try {
    return await db.getRow({ databaseId, tableId, rowId, ...(transactionId ? { transactionId } : {}) }) as SalesDealRow;
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

function serializeDeal(row: SalesDealRow) {
  return {
    id: row.$id,
    employeeId: String(row.employee_id),
    outletId: row.outlet_id ? String(row.outlet_id) : null,
    customerName: String(row.customer_name),
    title: String(row.title),
    stage: String(row.stage),
    amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
    nextAction: row.next_action ? String(row.next_action) : "",
    followUpAt: row.follow_up_at ? String(row.follow_up_at) : null,
    notes: row.notes ? String(row.notes) : "",
    updatedAt: row.$updatedAt,
  };
}

function receiptIdFor(operationId: string) {
  return stableManagementId("audit", "manager-deal-command", operationId);
}

function correlationIdFor(operationId: string) {
  return stableManagementId("corr", "manager-deal-command", operationId);
}
