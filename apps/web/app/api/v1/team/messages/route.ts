import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { employeeHasEffectiveRole, mobileActor } from "../../../../../lib/mobile-auth";
import { stableOperationId } from "../../../../../lib/mobile-write-idempotency";
import {
  commandReceiptJson,
  commandReceiptMatches,
  messageReplayMatches,
  type TeamDeskRow,
  validateMarkReadCommand,
  validateTeamMessageCommand,
} from "../../../../../lib/team-desk";
import {
  isAppwriteConflict,
  runManagementTransactionWithRetry,
  stableManagementId,
} from "../../../../../lib/management-write";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";
class ReadCommandConflict extends Error {}

export async function POST(request: Request) {
  const actor = await mobileActor(request);
  if (!actor) return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  if (!await employeeHasEffectiveRole(actor.employee.$id, "sales_person")) {
    return NextResponse.json({ error: "Salesperson access is required." }, { status: 403 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action === "mark_read") return markManagerMessagesRead(actor, body);
  if (body.action !== undefined && body.action !== "send") {
    return NextResponse.json({ error: "Choose send or mark_read." }, { status: 400 });
  }
  const parsed = validateTeamMessageCommand(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const command = parsed.value;
  const expected = {
    ...command,
    employeeId: actor.employee.$id,
    senderRole: "salesperson" as const,
    senderEmployeeId: actor.employee.$id,
  };
  const db = createAdminTablesDb();
  const existing = await messageByOperation(db, command.idempotencyKey);
  if (existing) return messageReplayResponse(existing, expected);

  const sentAt = new Date().toISOString();
  try {
    const row = await db.createRow({
      databaseId,
      tableId: "team_messages",
      rowId: stableOperationId("message", command.idempotencyKey),
      data: {
        employee_id: actor.employee.$id,
        sender_role: "salesperson",
        sender_employee_id: actor.employee.$id,
        body: command.body,
        sent_at: sentAt,
        idempotency_key: command.idempotencyKey,
      },
      permissions: [],
    }) as TeamDeskRow;
    return NextResponse.json({ ok: true, message: serializeMessage(row), created: true, replayed: false }, { status: 201 });
  } catch (error) {
    const committed = await messageByOperation(db, command.idempotencyKey).catch(() => null);
    if (committed) return messageReplayResponse(committed, expected);
    throw error;
  }
}

async function markManagerMessagesRead(
  actor: NonNullable<Awaited<ReturnType<typeof mobileActor>>>,
  body: Record<string, unknown>,
) {
  const parsed = validateMarkReadCommand(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = parsed.value;
  const db = createAdminTablesDb();
  const receiptId = stableManagementId("audit", "mobile-team-read", command.idempotencyKey);
  const expected = {
    actorUserId: actor.user.$id,
    action: "team.manager_messages_read",
    entityType: "employee",
    entityId: actor.employee.$id,
    command,
  };
  try {
    const result = await runManagementTransactionWithRetry(db, async (transactionId) => {
      const receipt = await getAuditOrNull(db, receiptId, transactionId);
      if (receipt) {
        if (!commandReceiptMatches(receipt, expected)) throw new ReadCommandConflict();
        return { ...readReceiptResult(receipt), replayed: true };
      }
      const readAt = new Date().toISOString();
      const updated = await db.updateRows({
        databaseId,
        tableId: "team_messages",
        transactionId,
        data: { read_at: readAt },
        queries: [
          Query.equal("employee_id", actor.employee.$id),
          Query.equal("sender_role", "manager"),
          Query.isNull("read_at"),
          Query.limit(100),
        ],
      });
      const marked = updated.rows.length;
      await db.createRow({
        databaseId,
        tableId: "audit_logs",
        rowId: receiptId,
        transactionId,
        data: {
          actor_user_id: actor.user.$id,
          action: "team.manager_messages_read",
          entity_type: "employee",
          entity_id: actor.employee.$id,
          occurred_at: readAt,
          after_json: commandReceiptJson(command, { marked, readAt }),
          reason: "Salesperson opened manager messages",
          correlation_id: stableManagementId("corr", "mobile-team-read", command.idempotencyKey),
        },
        permissions: [],
      });
      return { marked, readAt, replayed: false };
    });
    return NextResponse.json({ action: "mark_read", ok: true, ...result });
  } catch (error) {
    if (error instanceof ReadCommandConflict) {
      return NextResponse.json({
        error: "This request ID is already attached to a different read action. Try again with a new request ID.",
        code: "message_read_idempotency_conflict",
      }, { status: 409 });
    }
    if (isAppwriteConflict(error)) {
      return NextResponse.json({
        error: "Messages changed in another tab or request. Refresh and try again.",
        code: "messages_changed",
      }, { status: 409 });
    }
    return NextResponse.json({ error: "Messages could not be marked read. Retrying is safe." }, { status: 500 });
  }
}

async function getAuditOrNull(
  db: ReturnType<typeof createAdminTablesDb>,
  rowId: string,
  transactionId: string,
) {
  try {
    return await db.getRow({ databaseId, tableId: "audit_logs", rowId, transactionId }) as TeamDeskRow;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && Number(error.code) === 404) return null;
    throw error;
  }
}

function readReceiptResult(row: TeamDeskRow) {
  try {
    const stored = JSON.parse(String(row.after_json ?? "{}")) as { marked?: unknown; readAt?: unknown };
    return {
      marked: Number.isFinite(Number(stored.marked)) ? Number(stored.marked) : 0,
      readAt: typeof stored.readAt === "string" ? stored.readAt : String(row.occurred_at),
    };
  } catch {
    return { marked: 0, readAt: String(row.occurred_at) };
  }
}

async function messageByOperation(
  db: ReturnType<typeof createAdminTablesDb>,
  idempotencyKey: string,
) {
  return ((await db.listRows({
    databaseId,
    tableId: "team_messages",
    queries: [Query.equal("idempotency_key", idempotencyKey), Query.limit(1)],
  })).rows[0] as TeamDeskRow | undefined) ?? null;
}

function messageReplayResponse(
  row: TeamDeskRow,
  expected: Parameters<typeof messageReplayMatches>[1],
) {
  if (!messageReplayMatches(row, expected)) {
    return NextResponse.json({
      error: "This request ID is already attached to a different message. Send again with a new request ID.",
      code: "message_idempotency_conflict",
    }, { status: 409 });
  }
  return NextResponse.json({ ok: true, message: serializeMessage(row), created: false, replayed: true });
}

function serializeMessage(row: TeamDeskRow) {
  return {
    id: row.$id,
    employeeId: String(row.employee_id),
    senderRole: String(row.sender_role),
    senderEmployeeId: row.sender_employee_id ? String(row.sender_employee_id) : null,
    body: String(row.body),
    sentAt: String(row.sent_at),
    readAt: row.read_at ? String(row.read_at) : null,
  };
}
