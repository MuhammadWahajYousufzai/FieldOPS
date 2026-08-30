import { Query } from "node-appwrite";
import { NextResponse } from "next/server";
import { createAdminTablesDb } from "@fieldops/appwrite/server";
import { requireDashboardAdmin } from "../../../../lib/auth";
import { stableOperationId } from "../../../../lib/mobile-write-idempotency";
import {
  canonicalJson,
  commandReceiptJson,
  commandReceiptMatches,
  dealUpdateData,
  messageReplayMatches,
  type TeamDeskRow,
  validateDealCommand,
  validateEmployeePhoneCommand,
  validateManagerContactCommand,
  validateMarkReadCommand,
  validateTeamMessageCommand,
} from "../../../../lib/team-desk";
import {
  isAppwriteConflict,
  isAppwriteNotFound,
  runManagementTransactionWithRetry,
  stableManagementId,
} from "../../../../lib/management-write";

const databaseId = process.env.APPWRITE_DATABASE_ID ?? "fieldops";

class TeamCommandConflict extends Error {}
class TeamRecordChanged extends Error {}
class TeamRecordNotFound extends Error {}
class ActiveSalespersonRequired extends Error {}
class ActiveOutletRequired extends Error {}

export async function POST(request: Request) {
  const actor = await requireDashboardAdmin();
  if (!actor) return NextResponse.json({ error: "Admin access is required." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const db = createAdminTablesDb();

  try {
    if (body.action === "message") return await sendManagerMessage(db, actor, body);
    if (body.action === "mark_read") return await markSalespersonMessagesRead(db, actor, body);
    if (body.action === "contact") return await updateManagerContact(db, actor, body);
    if (body.action === "employee_phone") return await updateEmployeePhone(db, actor, body);
    if (body.action === "deal_update") return await updateDeal(db, actor, body);
    return NextResponse.json({ error: "Choose message, mark_read, contact, employee_phone, or deal_update." }, { status: 400 });
  } catch (error) {
    if (error instanceof TeamCommandConflict) {
      return NextResponse.json({
        error: "This request ID is already attached to different data. Save again with a new request ID.",
        code: "team_desk_idempotency_conflict",
      }, { status: 409 });
    }
    if (error instanceof TeamRecordChanged || isAppwriteConflict(error)) {
      return NextResponse.json({
        error: "This item changed in another tab or request. Refresh it before saving again.",
        code: "team_desk_item_changed",
      }, { status: 409 });
    }
    if (error instanceof ActiveSalespersonRequired) {
      return NextResponse.json({ error: "Choose an active salesperson." }, { status: 409 });
    }
    if (error instanceof ActiveOutletRequired) {
      return NextResponse.json({ error: "Choose an active customer place." }, { status: 409 });
    }
    if (error instanceof TeamRecordNotFound || isAppwriteNotFound(error)) {
      return NextResponse.json({ error: "This Team Desk item is no longer available." }, { status: 404 });
    }
    return NextResponse.json({
      error: "The Team Desk change could not be saved. No partial change was applied; retrying is safe.",
    }, { status: 500 });
  }
}

async function markSalespersonMessagesRead(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof requireDashboardAdmin>>>,
  body: Record<string, unknown>,
) {
  const employeeId = exactText(body.employeeId, 36);
  const parsed = validateMarkReadCommand({ ...body, idempotencyKey: body.operationId ?? body.idempotencyKey });
  if (!employeeId) return NextResponse.json({ error: "Choose an active salesperson." }, { status: 400 });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = { ...parsed.value, employeeId };
  const receiptId = managerReceiptId(parsed.value.idempotencyKey);
  const receiptExpected = {
    actorUserId: actor.user.$id,
    action: "team.salesperson_messages_read",
    entityType: "employee",
    entityId: employeeId,
    command,
  };
  const result = await runManagementTransactionWithRetry(db, async (transactionId) => {
    if (!await activeSalesperson(db, employeeId, transactionId)) throw new ActiveSalespersonRequired();
    const receipt = await getRowOrNull(db, "audit_logs", receiptId, transactionId);
    if (receipt) {
      if (!commandReceiptMatches(receipt, receiptExpected)) throw new TeamCommandConflict();
      return { ...readReceiptResult(receipt), replayed: true };
    }
    const readAt = new Date().toISOString();
    const updated = await db.updateRows({
      databaseId,
      tableId: "team_messages",
      transactionId,
      data: { read_at: readAt },
      queries: [
        Query.equal("employee_id", employeeId),
        Query.equal("sender_role", "salesperson"),
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
        action: "team.salesperson_messages_read",
        entity_type: "employee",
        entity_id: employeeId,
        occurred_at: readAt,
        after_json: commandReceiptJson(command, { marked, readAt }),
        reason: "Manager opened salesperson messages",
        correlation_id: managerCorrelationId(parsed.value.idempotencyKey),
      },
      permissions: [],
    });
    return { marked, readAt, replayed: false };
  });
  return NextResponse.json({ action: "mark_read", ok: true, employeeId, ...result });
}

async function sendManagerMessage(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof requireDashboardAdmin>>>,
  body: Record<string, unknown>,
) {
  const employeeId = exactText(body.employeeId, 36);
  const parsed = validateTeamMessageCommand({ ...body, idempotencyKey: body.operationId ?? body.idempotencyKey });
  if (!employeeId) return NextResponse.json({ error: "Choose an active salesperson." }, { status: 400 });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = parsed.value;
  const senderEmployeeId = await employeeIdForUser(db, actor.user.$id);
  const expected = {
    ...command,
    employeeId,
    senderRole: "manager" as const,
    senderEmployeeId,
  };
  const existing = await messageByOperation(db, command.idempotencyKey);
  if (existing) return managerMessageReplayResponse(existing, expected);

  const messageId = stableOperationId("message", command.idempotencyKey);
  const receiptId = managerReceiptId(command.idempotencyKey);
  const now = new Date().toISOString();
  try {
    const outcome = await runManagementTransactionWithRetry(db, async (transactionId) => {
      if (!await activeSalesperson(db, employeeId, transactionId)) throw new ActiveSalespersonRequired();
      // The message row is the source of truth for exact replay matching. Keep
      // free-form message text out of the longer-lived audit receipt so a
      // future message deletion cannot leave a second plaintext copy behind.
      const receiptCommand = { employeeId, messageId };
      const receipt = await getRowOrNull(db, "audit_logs", receiptId, transactionId);
      if (receipt && !commandReceiptMatches(receipt, {
        actorUserId: actor.user.$id,
        action: "team.message_sent",
        entityType: "team_message",
        entityId: messageId,
        command: receiptCommand,
      })) throw new TeamCommandConflict();
      const replay = await getRowOrNull(db, "team_messages", messageId, transactionId);
      if (replay) {
        if (!messageReplayMatches(replay, expected)) throw new TeamCommandConflict();
        return { row: replay, replayed: true };
      }
      if (receipt) throw new TeamRecordNotFound();
      const created = await db.createRow({
        databaseId,
        tableId: "team_messages",
        rowId: messageId,
        transactionId,
        data: {
          employee_id: employeeId,
          sender_role: "manager",
          ...(senderEmployeeId ? { sender_employee_id: senderEmployeeId } : {}),
          body: command.body,
          sent_at: now,
          idempotency_key: command.idempotencyKey,
        },
        permissions: [],
      }) as TeamDeskRow;
      await db.createRow({
        databaseId,
        tableId: "audit_logs",
        rowId: receiptId,
        transactionId,
        data: {
          actor_user_id: actor.user.$id,
          action: "team.message_sent",
          entity_type: "team_message",
          entity_id: messageId,
          occurred_at: now,
          after_json: commandReceiptJson(receiptCommand),
          reason: "Sent from the manager Team Desk",
          correlation_id: managerCorrelationId(command.idempotencyKey),
        },
        permissions: [],
      });
      return { row: created, replayed: false };
    });
    return NextResponse.json(
      {
        action: "message",
        ok: true,
        message: serializeMessage(outcome.row),
        created: !outcome.replayed,
        replayed: outcome.replayed,
      },
      { status: outcome.replayed ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof TeamCommandConflict || error instanceof ActiveSalespersonRequired) throw error;
    const committed = await messageByOperation(db, command.idempotencyKey).catch(() => null);
    if (committed) return managerMessageReplayResponse(committed, expected);
    throw error;
  }
}

async function updateManagerContact(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof requireDashboardAdmin>>>,
  body: Record<string, unknown>,
) {
  const parsed = validateManagerContactCommand(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = parsed.value;
  const receiptId = managerReceiptId(command.operationId);

  const outcome = await runManagementTransactionWithRetry(db, async (transactionId) => {
    const organization = await activeOrganization(db, transactionId);
    if (!organization) throw new TeamRecordNotFound();
    const receiptExpected = {
      actorUserId: actor.user.$id,
      action: "team.contact_updated",
      entityType: "organization",
      entityId: organization.$id,
      command,
    };
    const receipt = await getRowOrNull(db, "audit_logs", receiptId, transactionId);
    if (receipt) {
      if (!commandReceiptMatches(receipt, receiptExpected)) throw new TeamCommandConflict();
      return { row: organization, changed: false, replayed: true };
    }
    const same = String(organization.manager_contact_name ?? "") === command.name
      && String(organization.manager_contact_phone ?? "") === command.phone
      && String(organization.manager_contact_whatsapp ?? "") === command.whatsapp;
    if (!same && command.expectedUpdatedAt && organization.$updatedAt !== command.expectedUpdatedAt) throw new TeamRecordChanged();
    let row = organization;
    if (!same) {
      row = await db.updateRow({
        databaseId,
        tableId: "organizations",
        rowId: organization.$id,
        transactionId,
        data: {
          manager_contact_name: command.name,
          manager_contact_phone: command.phone,
          manager_contact_whatsapp: command.whatsapp,
        },
      });
    }
    await createCommandReceipt(db, transactionId, receiptId, {
      actorUserId: actor.user.$id,
      action: "team.contact_updated",
      entityType: "organization",
      entityId: organization.$id,
      command,
      before: {
        name: organization.manager_contact_name ?? "",
        phone: organization.manager_contact_phone ?? "",
        whatsapp: organization.manager_contact_whatsapp ?? "",
      },
      reason: "Updated the single-organization manager contact",
      operationId: command.operationId,
    });
    return { row, changed: !same, replayed: false };
  });
  const committed = await db.getRow({ databaseId, tableId: "organizations", rowId: outcome.row.$id });
  return NextResponse.json({
    action: "contact",
    ok: true,
    contact: serializeContact(committed),
    changed: outcome.changed,
    replayed: outcome.replayed,
  });
}

async function updateEmployeePhone(
  db: ReturnType<typeof createAdminTablesDb>,
  actor: NonNullable<Awaited<ReturnType<typeof requireDashboardAdmin>>>,
  body: Record<string, unknown>,
) {
  const parsed = validateEmployeePhoneCommand(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const command = parsed.value;
  const receiptId = managerReceiptId(command.operationId);
  const receiptExpected = {
    actorUserId: actor.user.$id,
    action: "team.employee_phone_updated",
    entityType: "employee",
    entityId: command.employeeId,
    command,
  };

  const outcome = await runManagementTransactionWithRetry(db, async (transactionId) => {
    const employee = await activeSalesperson(db, command.employeeId, transactionId);
    if (!employee) throw new ActiveSalespersonRequired();
    const receipt = await getRowOrNull(db, "audit_logs", receiptId, transactionId);
    if (receipt) {
      if (!commandReceiptMatches(receipt, receiptExpected)) throw new TeamCommandConflict();
      return { row: employee, changed: false, replayed: true };
    }
    if (command.expectedUpdatedAt && employee.$updatedAt !== command.expectedUpdatedAt) throw new TeamRecordChanged();
    const same = String(employee.phone ?? "") === command.phone;
    let row = employee;
    if (!same) {
      const updated = await db.updateRows({
        databaseId,
        tableId: "employees",
        transactionId,
        data: { phone: command.phone },
        queries: [
          Query.equal("$id", command.employeeId),
          Query.equal("status", "active"),
          Query.equal("$updatedAt", employee.$updatedAt),
        ],
      });
      const updatedRow = updated.rows[0] as TeamDeskRow | undefined;
      if (!updatedRow) throw new TeamRecordChanged();
      row = updatedRow;
    }
    await createCommandReceipt(db, transactionId, receiptId, {
      ...receiptExpected,
      before: { phone: employee.phone ?? "" },
      reason: "Updated salesperson call and WhatsApp target",
      operationId: command.operationId,
    });
    return { row, changed: !same, replayed: false };
  });
  return NextResponse.json({
    action: "employee_phone",
    ok: true,
    employee: {
      id: outcome.row.$id,
      name: String(outcome.row.display_name),
      phone: String(outcome.row.phone ?? ""),
      updatedAt: outcome.row.$updatedAt,
    },
    changed: outcome.changed,
    replayed: outcome.replayed,
  });
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
  const receiptId = managerReceiptId(command.idempotencyKey);
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
      if (!commandReceiptMatches(receipt, receiptExpected)) throw new TeamCommandConflict();
      const replayDeal = await getRowOrNull(db, "sales_deals", command.dealId, transactionId);
      if (!replayDeal) throw new TeamRecordNotFound();
      return { row: replayDeal, replayed: true };
    }
    const current = await getRowOrNull(db, "sales_deals", command.dealId, transactionId);
    if (!current) throw new TeamRecordNotFound();
    if (command.expectedUpdatedAt && current.$updatedAt !== command.expectedUpdatedAt) throw new TeamRecordChanged();
    if (command.updates.outletId) await requireActiveOutlet(db, command.updates.outletId, transactionId);
    const updated = await db.updateRows({
      databaseId,
      tableId: "sales_deals",
      transactionId,
      data: { ...dealUpdateData(command.updates), updated_by: actor.user.$id },
      queries: [Query.equal("$id", command.dealId), Query.equal("$updatedAt", current.$updatedAt)],
    });
    const row = updated.rows[0] as TeamDeskRow | undefined;
    if (!row) throw new TeamRecordChanged();
    await createCommandReceipt(db, transactionId, receiptId, {
      ...receiptExpected,
      before: { stage: current.stage, amount: current.amount, nextAction: current.next_action, followUpAt: current.follow_up_at },
      reason: "Updated from the manager Team Desk",
      operationId: command.idempotencyKey,
    });
    return { row, replayed: false };
  });
  return NextResponse.json({
    action: "deal_update",
    ok: true,
    deal: serializeDeal(outcome.row),
    changed: !outcome.replayed,
    replayed: outcome.replayed,
  });
}

async function createCommandReceipt(
  db: ReturnType<typeof createAdminTablesDb>,
  transactionId: string,
  receiptId: string,
  input: {
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    command: unknown;
    before: unknown;
    reason: string;
    operationId: string;
  },
) {
  await db.createRow({
    databaseId,
    tableId: "audit_logs",
    rowId: receiptId,
    transactionId,
    data: {
      actor_user_id: input.actorUserId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      occurred_at: new Date().toISOString(),
      before_json: canonicalJson(input.before),
      after_json: commandReceiptJson(input.command),
      reason: input.reason,
      correlation_id: managerCorrelationId(input.operationId),
    },
    permissions: [],
  });
}

async function activeOrganization(db: ReturnType<typeof createAdminTablesDb>, transactionId: string) {
  return ((await db.listRows({
    databaseId,
    tableId: "organizations",
    transactionId,
    queries: [Query.equal("active", true), Query.orderAsc("$createdAt"), Query.limit(1)],
    total: false,
    ttl: 0,
  })).rows[0] as TeamDeskRow | undefined) ?? null;
}

async function activeSalesperson(
  db: ReturnType<typeof createAdminTablesDb>,
  employeeId: string,
  transactionId: string,
) {
  const employee = await getRowOrNull(db, "employees", employeeId, transactionId);
  if (!employee || employee.status !== "active") return null;
  const role = (await db.listRows({
    databaseId,
    tableId: "roles",
    transactionId,
    queries: [Query.equal("code", "sales_person"), Query.equal("active", true), Query.limit(1)],
    total: false,
    ttl: 0,
  })).rows[0];
  if (!role) return null;
  const assignments = await db.listRows({
    databaseId,
    tableId: "employee_assignments",
    transactionId,
    queries: [Query.equal("employee_id", employeeId), Query.limit(100)],
    total: false,
    ttl: 0,
  });
  const now = Date.now();
  return assignments.rows.some((assignment) => String(assignment.role_id) === role.$id && assignmentEffective(assignment, now))
    ? employee
    : null;
}

async function requireActiveOutlet(
  db: ReturnType<typeof createAdminTablesDb>,
  outletId: string,
  transactionId: string,
) {
  const outlet = await getRowOrNull(db, "outlets", outletId, transactionId);
  if (!outlet || outlet.status !== "active") throw new ActiveOutletRequired();
}

async function messageByOperation(db: ReturnType<typeof createAdminTablesDb>, operationId: string) {
  return ((await db.listRows({
    databaseId,
    tableId: "team_messages",
    queries: [Query.equal("idempotency_key", operationId), Query.limit(1)],
  })).rows[0] as TeamDeskRow | undefined) ?? null;
}

async function getRowOrNull(
  db: ReturnType<typeof createAdminTablesDb>,
  tableId: string,
  rowId: string,
  transactionId?: string,
) {
  try {
    return await db.getRow({ databaseId, tableId, rowId, ...(transactionId ? { transactionId } : {}) }) as TeamDeskRow;
  } catch (error) {
    if (isAppwriteNotFound(error)) return null;
    throw error;
  }
}

function managerMessageReplayResponse(row: TeamDeskRow, expected: Parameters<typeof messageReplayMatches>[1]) {
  if (!messageReplayMatches(row, expected)) throw new TeamCommandConflict();
  return NextResponse.json({ action: "message", ok: true, message: serializeMessage(row), created: false, replayed: true });
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

function serializeDeal(row: TeamDeskRow) {
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

function serializeContact(row: TeamDeskRow) {
  return {
    name: String(row.manager_contact_name ?? ""),
    phone: String(row.manager_contact_phone ?? ""),
    whatsapp: String(row.manager_contact_whatsapp ?? ""),
    updatedAt: row.$updatedAt,
  };
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

function managerReceiptId(operationId: string) {
  return stableManagementId("audit", "manager-team-command", operationId);
}

function managerCorrelationId(operationId: string) {
  return stableManagementId("corr", "manager-team-command", operationId);
}

async function employeeIdForUser(
  db: ReturnType<typeof createAdminTablesDb>,
  userId: string,
) {
  const rows = await db.listRows({
    databaseId,
    tableId: "employees",
    queries: [Query.equal("user_id", userId), Query.limit(1)],
    total: false,
  });
  return rows.rows[0]?.$id ?? null;
}

function exactText(value: unknown, maximum: number) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : "";
}

function assignmentEffective(assignment: Record<string, unknown>, now: number) {
  const startsAt = new Date(String(assignment.effective_from ?? "")).valueOf();
  if (!Number.isFinite(startsAt) || startsAt > now) return false;
  if (!assignment.effective_to) return true;
  const endsAt = new Date(String(assignment.effective_to)).valueOf();
  return Number.isFinite(endsAt) && endsAt > now;
}
