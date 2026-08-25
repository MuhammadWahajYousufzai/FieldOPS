import { createHash } from "node:crypto";
import type { Models } from "node-appwrite";

export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export const ACTIVE_DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation"] as const;
export type DealStage = typeof DEAL_STAGES[number];
export type TeamDeskRow = Models.Row & Record<string, unknown>;

const COMMAND_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export type TeamMessageCommand = {
  idempotencyKey: string;
  body: string;
};

export type MarkReadCommand = {
  idempotencyKey: string;
};

type DealFields = {
  outletId: string | null;
  customerName: string;
  title: string;
  stage: DealStage;
  amount: number | null;
  nextAction: string;
  followUpAt: string | null;
  notes: string;
};

export type CreateDealCommand = DealFields & {
  action: "create";
  idempotencyKey: string;
};

export type UpdateDealCommand = {
  action: "update";
  requestedAction: "update" | "stage_update";
  idempotencyKey: string;
  dealId: string;
  expectedUpdatedAt: string;
  updates: Partial<DealFields>;
};

export type DealCommand = CreateDealCommand | UpdateDealCommand;

export type ManagerContactCommand = {
  operationId: string;
  name: string;
  phone: string;
  whatsapp: string;
  expectedUpdatedAt: string;
};

export type EmployeePhoneCommand = {
  operationId: string;
  employeeId: string;
  phone: string;
  expectedUpdatedAt: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateTeamMessageCommand(input: Record<string, unknown>): ValidationResult<TeamMessageCommand> {
  const key = commandKey(input.idempotencyKey ?? input.operationId);
  if (!key) return invalid("A valid request ID is required.");
  const body = boundedText(input.body, 2_000);
  if (body === null || !body) return invalid("Write a message of 2,000 characters or fewer.");
  return { ok: true, value: { idempotencyKey: key, body } };
}

export function validateMarkReadCommand(input: Record<string, unknown>): ValidationResult<MarkReadCommand> {
  const idempotencyKey = commandKey(input.idempotencyKey ?? input.operationId);
  return idempotencyKey
    ? { ok: true, value: { idempotencyKey } }
    : invalid("A valid request ID is required.");
}

export function validateDealCommand(input: Record<string, unknown>): ValidationResult<DealCommand> {
  const idempotencyKey = commandKey(input.idempotencyKey ?? input.operationId);
  if (!idempotencyKey) return invalid("A valid request ID is required.");
  const action = input.action === "stage_update" ? "update" : input.action;
  if (action !== "create" && action !== "update") return invalid("Choose create or stage_update.");

  if (action === "create") {
    const customerName = requiredText(input.customerName, 160);
    const title = requiredText(input.title, 160);
    const stage = dealStage(input.stage);
    const outletId = optionalIdentifier(input.outletId);
    const amount = optionalAmount(input.amount);
    const nextAction = optionalText(input.nextAction, 500);
    const followUpAt = optionalDate(input.followUpAt);
    const notes = optionalText(input.notes, 16_383);
    if (!customerName || !title || !stage || outletId === undefined || amount === undefined
      || nextAction === null || followUpAt === undefined || notes === null) {
      return invalid("Customer, title, stage, amount, follow-up, outlet, or notes are invalid.");
    }
    return {
      ok: true,
      value: {
        action: "create",
        idempotencyKey,
        outletId,
        customerName,
        title,
        stage,
        amount,
        nextAction,
        followUpAt,
        notes,
      },
    };
  }

  const dealId = requiredText(input.dealId, 36);
  if (!dealId) return invalid("Choose a deal to update.");
  const expectedUpdatedAt = requiredVersion(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return invalid("Update Team Desk before changing this deal.");
  const updates: Partial<DealFields> = {};
  if (has(input, "outletId")) {
    const value = optionalIdentifier(input.outletId);
    if (value === undefined) return invalid("The outlet is invalid.");
    updates.outletId = value;
  }
  if (has(input, "customerName")) {
    const value = requiredText(input.customerName, 160);
    if (!value) return invalid("Customer name is required.");
    updates.customerName = value;
  }
  if (has(input, "title")) {
    const value = requiredText(input.title, 160);
    if (!value) return invalid("Deal title is required.");
    updates.title = value;
  }
  if (has(input, "stage")) {
    const value = dealStage(input.stage);
    if (!value) return invalid("Choose a valid deal stage.");
    updates.stage = value;
  }
  if (has(input, "amount")) {
    const value = optionalAmount(input.amount);
    if (value === undefined) return invalid("Amount must be zero or greater.");
    updates.amount = value;
  }
  if (has(input, "nextAction")) {
    const value = optionalText(input.nextAction, 500);
    if (value === null) return invalid("Next action must be 500 characters or fewer.");
    updates.nextAction = value;
  }
  if (has(input, "followUpAt")) {
    const value = optionalDate(input.followUpAt);
    if (value === undefined) return invalid("Follow-up date is invalid.");
    updates.followUpAt = value;
  }
  if (has(input, "notes")) {
    const value = optionalText(input.notes, 16_383);
    if (value === null) return invalid("Notes are too long.");
    updates.notes = value;
  }
  if (Object.keys(updates).length === 0) return invalid("Make at least one deal change.");
  return {
    ok: true,
    value: {
      action: "update",
      requestedAction: input.action === "stage_update" ? "stage_update" : "update",
      idempotencyKey,
      dealId,
      expectedUpdatedAt,
      updates,
    },
  };
}

export function validateManagerContactCommand(input: Record<string, unknown>): ValidationResult<ManagerContactCommand> {
  const operationId = commandKey(input.operationId ?? input.idempotencyKey);
  if (!operationId) return invalid("A valid request ID is required.");
  const name = requiredText(input.name ?? input.managerContactName, 128);
  const phone = phoneText(input.phone ?? input.managerContactPhone);
  const whatsapp = phoneText(input.whatsapp ?? input.managerContactWhatsapp);
  const expectedUpdatedAt = requiredVersion(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return invalid("Update Team Desk before changing the manager contact.");
  if (!name || phone === null || whatsapp === null || (!phone && !whatsapp)) {
    return invalid("Manager name and at least one valid phone or WhatsApp number are required.");
  }
  return { ok: true, value: { operationId, name, phone, whatsapp, expectedUpdatedAt } };
}

export function validateEmployeePhoneCommand(input: Record<string, unknown>): ValidationResult<EmployeePhoneCommand> {
  const operationId = commandKey(input.operationId ?? input.idempotencyKey);
  const employeeId = requiredText(input.employeeId, 36);
  const phone = phoneText(input.phone);
  const expectedUpdatedAt = requiredVersion(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return invalid("Update Team Desk before changing this salesperson's phone.");
  if (!operationId || !employeeId || !phone) {
    return invalid("Choose an active salesperson and enter a valid phone number.");
  }
  return { ok: true, value: { operationId, employeeId, phone, expectedUpdatedAt } };
}

export function messageReplayMatches(
  row: TeamDeskRow,
  expected: TeamMessageCommand & { employeeId: string; senderRole: "manager" | "salesperson"; senderEmployeeId: string | null },
) {
  return String(row.idempotency_key ?? "") === expected.idempotencyKey
    && String(row.employee_id ?? "") === expected.employeeId
    && String(row.sender_role ?? "") === expected.senderRole
    && (row.sender_employee_id ? String(row.sender_employee_id) : null) === expected.senderEmployeeId
    && String(row.body ?? "") === expected.body;
}

export function dealCreateReplayMatches(
  row: TeamDeskRow,
  expected: CreateDealCommand & { employeeId: string },
) {
  return String(row.idempotency_key ?? "") === expected.idempotencyKey
    && String(row.employee_id ?? "") === expected.employeeId
    && blankOrString(row.outlet_id) === (expected.outletId ?? "")
    && String(row.customer_name ?? "") === expected.customerName
    && String(row.title ?? "") === expected.title
    && String(row.stage ?? "") === expected.stage
    && nullableNumber(row.amount) === expected.amount
    && blankOrString(row.next_action) === expected.nextAction
    && nullableInstant(row.follow_up_at) === expected.followUpAt
    && blankOrString(row.notes) === expected.notes;
}

export function commandReceiptMatches(
  row: TeamDeskRow,
  expected: { actorUserId: string; action: string; entityType: string; entityId: string; command: unknown },
) {
  if (String(row.actor_user_id ?? "") !== expected.actorUserId
    || String(row.action ?? "") !== expected.action
    || String(row.entity_type ?? "") !== expected.entityType
    || String(row.entity_id ?? "") !== expected.entityId) return false;
  try {
    const stored = JSON.parse(String(row.after_json ?? "{}")) as { command?: unknown; commandDigest?: unknown };
    if (stored.command !== undefined) return canonicalJson(stored.command) === canonicalJson(expected.command);
    return typeof stored.commandDigest === "string" && stored.commandDigest === commandDigest(expected.command);
  } catch {
    return false;
  }
}

export function commandReceiptJson(command: unknown, result?: Record<string, unknown>) {
  const encoded = canonicalJson(command);
  return canonicalJson({
    ...(encoded.length <= 12_000 ? { command } : { commandDigest: commandDigest(command) }),
    ...(result ?? {}),
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function dealUpdateData(updates: UpdateDealCommand["updates"]) {
  return {
    ...(has(updates, "outletId") ? { outlet_id: updates.outletId } : {}),
    ...(has(updates, "customerName") ? { customer_name: updates.customerName } : {}),
    ...(has(updates, "title") ? { title: updates.title } : {}),
    ...(has(updates, "stage") ? { stage: updates.stage } : {}),
    ...(has(updates, "amount") ? { amount: updates.amount } : {}),
    ...(has(updates, "nextAction") ? { next_action: updates.nextAction } : {}),
    ...(has(updates, "followUpAt") ? { follow_up_at: updates.followUpAt } : {}),
    ...(has(updates, "notes") ? { notes: updates.notes } : {}),
  };
}

function commandKey(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized === value.trim() && COMMAND_KEY_PATTERN.test(normalized) ? normalized : "";
}

function boundedText(value: unknown, maximum: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : null;
}

function requiredText(value: unknown, maximum: number) {
  const normalized = boundedText(value, maximum);
  return normalized || "";
}

function optionalText(value: unknown, maximum: number) {
  if (value === null || value === undefined) return "";
  return boundedText(value, maximum);
}

function optionalIdentifier(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 36 ? normalized : undefined;
}

function optionalAmount(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  if (typeof normalized === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function requiredVersion(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 40 || Number.isNaN(new Date(value).valueOf())) return "";
  return value;
}

function dealStage(value: unknown): DealStage | null {
  return typeof value === "string" && (DEAL_STAGES as readonly string[]).includes(value)
    ? value as DealStage
    : null;
}

function phoneText(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const digits = normalized.replace(/\D/g, "");
  const plusCount = [...normalized].filter((character) => character === "+").length;
  return normalized.length <= 32
    && /^[+0-9() .-]+$/.test(normalized)
    && plusCount <= 1
    && (plusCount === 0 || normalized.startsWith("+"))
    && digits.length >= 7
    && digits.length <= 15
    ? normalized
    : null;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function commandDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function blankOrString(value: unknown) {
  return value == null ? "" : String(value);
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function nullableInstant(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.valueOf()) ? "invalid" : parsed.toISOString();
}

function has(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}
