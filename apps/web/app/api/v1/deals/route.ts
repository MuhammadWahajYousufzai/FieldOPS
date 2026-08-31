import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { employeeHasEffectiveRole, mobileActor } from "../../../../lib/mobile-auth";
import { stableOperationId } from "../../../../lib/mobile-write-idempotency";
import {
  canonicalJson,
  commandReceiptJson,
  commandReceiptMatches,
  dealCreateReplayMatches,
  dealUpdateData,
  type CreateDealCommand,
  type SalesDealRow,
  type UpdateDealCommand,
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
class DealVersionConflict extends Error {}
class DealNotFound extends Error {}
class OutletNotAvailable extends Error {}

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!await employeeHasEffectiveRole(actor.employee.$id, "sales_person")) {
    return NextResponse.json({ error: "Salesperson access is required." }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const parsed = validateDealCommand(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const db = createAdminTablesDb();
  try {
    return parsed.value.action === "create"
      ? await createDeal(db, actor, parsed.value)
      : await updateDeal(db, actor, parsed.value);
  } catch (error) {
    if (error instanceof DealCommandConflict) {
      return NextResponse.json({
        error: "This request ID is already attached to different deal data. Save again with a new request ID.",
        code: "deal_idempotency_conflict",
      }, { status: 409 });
    }
    if (error instanceof DealVersionConflict || isAppwriteConflict(error)) {
      return NextResponse.json({
        error: "This deal changed in another tab or request. Refresh it before saving again.",
        code: "deal_changed",
      }, { status: 409 });
    }
    if (error instanceof DealNotFound || isAppwriteNotFound(error)) {
      return NextResponse.json({ error: "This deal is no longer available." }, { status: 404 });
    }
    if (error instanceof OutletNotAvailable) {
      return NextResponse.json({ error: "Choose an active customer place." }, { status: 409 });
    }
    return NextResponse.json({
      error: "The deal could not be saved. No partial change was applied; retrying is safe.",
    }, { status: 500 });
  }
}

async function createDeal(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof mobileActor>>>,
  command: CreateDealCommand,
) {
  const expected = { ...command, employeeId: actor.employee.$id };
  const existing = await dealByOperation(db, command.idempotencyKey);
  if (existing) return dealCreateReplayResponse(existing, expected);
  if (command.outletId) await requireActiveOutlet(db, command.outletId);

  const dealId = stableOperationId("deal", command.idempotencyKey);
  const receiptId = stableManagementId("audit", "mobile-deal-create", command.idempotencyKey);
  const correlationId = stableManagementId("corr", "mobile-deal-create", command.idempotencyKey);
  const now = new Date().toISOString();
  try {
    const outcome = await runManagementTransactionWithRetry(db, async (transactionId) => {
      const replay = await getRowOrNull(db, "sales_deals", dealId, transactionId);
      if (replay) {
        if (!dealCreateReplayMatches(replay, expected)) throw new DealCommandConflict();
        return { row: replay, replayed: true };
      }
      if (command.outletId) await requireActiveOutlet(db, command.outletId, transactionId);
      const created = await db.createRow({
        databaseId,
        tableId: "sales_deals",
        rowId: dealId,
        transactionId,
        data: {
          employee_id: actor.employee.$id,
          ...(command.outletId ? { outlet_id: command.outletId } : {}),
          customer_name: command.customerName,
          title: command.title,
          stage: command.stage,
          ...(command.amount !== null ? { amount: command.amount } : {}),
          next_action: command.nextAction,
          ...(command.followUpAt ? { follow_up_at: command.followUpAt } : {}),
          notes: command.notes,
          idempotency_key: command.idempotencyKey,
          updated_by: actor.user.$id,
        },
        permissions: [],
      }) as SalesDealRow;
      await db.createRow({
        databaseId,
        tableId: "audit_logs",
        rowId: receiptId,
        transactionId,
        data: {
          actor_user_id: actor.user.$id,
          action: "sales.deal_created",
          entity_type: "sales_deal",
          entity_id: dealId,
          occurred_at: now,
          after_json: commandReceiptJson(command),
          reason: "Created by salesperson",
          correlation_id: correlationId,
        },
        permissions: [],
      });
      return { row: created, replayed: false };
    });
    return NextResponse.json(
      { ok: true, deal: serializeDeal(outcome.row), created: !outcome.replayed, replayed: outcome.replayed },
      { status: outcome.replayed ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof DealCommandConflict) throw error;
    const committed = await dealByOperation(db, command.idempotencyKey).catch(() => null);
    if (committed) return dealCreateReplayResponse(committed, expected);
    throw error;
  }
}

async function updateDeal(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof mobileActor>>>,
  command: UpdateDealCommand,
) {
  const receiptId = stableManagementId("audit", "mobile-deal-update", command.idempotencyKey);
  const correlationId = stableManagementId("corr", "mobile-deal-update", command.idempotencyKey);
  const receiptExpected = {
    actorUserId: actor.user.$id,
    action: "sales.deal_updated",
    entityType: "sales_deal",
    entityId: command.dealId,
    command,
  };
  const outcome = await runManagementTransactionWithRetry(db, async (transactionId) => {
    const receipt = await getRowOrNull(db, "audit_logs", receiptId, transactionId);
    if (receipt) {
      if (!commandReceiptMatches(receipt, receiptExpected)) throw new DealCommandConflict();
      const replayDeal = await getRowOrNull(db, "sales_deals", command.dealId, transactionId);
      if (!replayDeal || String(replayDeal.employee_id) !== actor.employee.$id) throw new DealNotFound();
      return { row: replayDeal, replayed: true };
    }

    const current = await getRowOrNull(db, "sales_deals", command.dealId, transactionId);
    if (!current || String(current.employee_id) !== actor.employee.$id) throw new DealNotFound();
    if (command.expectedUpdatedAt && current.$updatedAt !== command.expectedUpdatedAt) throw new DealVersionConflict();
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
        action: "sales.deal_updated",
        entity_type: "sales_deal",
        entity_id: command.dealId,
        occurred_at: new Date().toISOString(),
        before_json: canonicalJson({ stage: current.stage, amount: current.amount, nextAction: current.next_action, followUpAt: current.follow_up_at }),
        after_json: commandReceiptJson(command),
        reason: "Updated by salesperson",
        correlation_id: correlationId,
      },
      permissions: [],
    });
    return { row, replayed: false };
  });
  const committed = await db.getRow({ databaseId, tableId: "sales_deals", rowId: outcome.row.$id });
  return NextResponse.json({
    ok: true,
    deal: serializeDeal(committed),
    changed: !outcome.replayed,
    replayed: outcome.replayed,
  });
}

async function requireActiveOutlet(
  db: ReturnType<typeof createAdminTablesDb>,
  outletId: string,
  transactionId?: string,
) {
  const outlet = await getRowOrNull(db, "outlets", outletId, transactionId);
  if (!outlet || outlet.status !== "active") throw new OutletNotAvailable();
}

async function dealByOperation(db: ReturnType<typeof createAdminTablesDb>, idempotencyKey: string) {
  return ((await db.listRows({
    databaseId,
    tableId: "sales_deals",
    queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)],
  })).rows[0] as SalesDealRow | undefined) ?? null;
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

function dealCreateReplayResponse(row: SalesDealRow, expected: Parameters<typeof dealCreateReplayMatches>[1]) {
  if (!dealCreateReplayMatches(row, expected)) throw new DealCommandConflict();
  return NextResponse.json({ ok: true, deal: serializeDeal(row), created: false, replayed: true });
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
