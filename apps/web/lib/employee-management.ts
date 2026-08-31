import type { Models } from "node-appwrite";

export const EMPLOYEE_OPERATIONAL_DEPENDENCIES = [
  { key: "directReports", label: "direct reports", tableId: "employees", field: "manager_employee_id", identifier: "employee" },
  { key: "assignedOutlets", label: "assigned outlets", tableId: "outlets", field: "assigned_employee_id", identifier: "employee" },
  { key: "routeAssignments", label: "route assignments", tableId: "route_assignments", field: "employee_id", identifier: "employee" },
  { key: "attendanceRecords", label: "attendance records", tableId: "attendance_records", field: "employee_id", identifier: "employee" },
  { key: "visits", label: "visits", tableId: "visits", field: "employee_id", identifier: "employee" },
  { key: "visitEvidence", label: "visit evidence", tableId: "visit_evidence", field: "employee_id", identifier: "employee" },
  { key: "locationPoints", label: "location points", tableId: "location_points", field: "employee_id", identifier: "employee" },
  { key: "orders", label: "orders", tableId: "orders", field: "employee_id", identifier: "employee" },
  { key: "teamMessages", label: "legacy records", tableId: "team_messages", field: "employee_id", identifier: "employee" },
  { key: "sentTeamMessages", label: "legacy sent records", tableId: "team_messages", field: "sender_employee_id", identifier: "employee", scan: true },
  { key: "salesDeals", label: "sales deals", tableId: "sales_deals", field: "employee_id", identifier: "employee" },
  { key: "routeSequenceCounters", label: "route sequence counters", tableId: "route_sequence_counters", field: "employee_id", identifier: "employee" },
  { key: "actorAuditLogs", label: "actor audit records", tableId: "audit_logs", field: "actor_user_id", identifier: "user" },
] as const;

export type EmployeeOperationalDependencyKey = typeof EMPLOYEE_OPERATIONAL_DEPENDENCIES[number]["key"];

export type EmployeeProfileCommand = {
  action: "profile";
  operationId: string;
  expectedUpdatedAt: string;
  expectedAuthUpdatedAt: string;
  name: string;
  email: string;
  phone: string;
};

export type EmployeePasswordCommand = {
  action: "password";
  operationId: string;
  expectedUpdatedAt: string;
  expectedAuthUpdatedAt: string;
  password: string;
};

export type EmployeeStatusCommand = {
  action: "status";
  operationId: string;
  expectedUpdatedAt: string;
  expectedAuthUpdatedAt: string;
  status: "active" | "inactive";
};

export type EmployeeMutationCommand = EmployeeProfileCommand | EmployeePasswordCommand | EmployeeStatusCommand;

export type EmployeeDeleteCommand = {
  action: "delete";
  operationId: string;
  expectedUpdatedAt: string;
  expectedAuthUpdatedAt: string;
  confirmationEmail: string;
};

export type EmployeeValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type EmployeeDependencyCount = {
  key: EmployeeOperationalDependencyKey;
  label: string;
  count: number;
};

export type EmployeeDependencySummary = {
  blocked: boolean;
  total: number;
  dependencies: EmployeeDependencyCount[];
  message: string;
};

type AuditRow = Record<string, unknown>;

const APPWRITE_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmployeeId(value: unknown): value is string {
  return typeof value === "string" && APPWRITE_IDENTIFIER_PATTERN.test(value);
}

export function validateEmployeeMutation(input: Record<string, unknown>): EmployeeValidationResult<EmployeeMutationCommand> {
  const operationId = operationIdText(input.operationId);
  if (!operationId) return invalid("A valid request ID is required.");
  const expectedUpdatedAt = versionText(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) return invalid("Refresh this salesperson before saving changes.");
  const expectedAuthUpdatedAt = optionalVersionText(input.expectedAuthUpdatedAt);
  if (expectedAuthUpdatedAt === null) return invalid("Refresh this salesperson's Auth identity before saving changes.");

  if (input.action === "profile") {
    const name = requiredText(input.name, 128);
    const email = emailText(input.email);
    const phone = phoneText(input.phone);
    if (!name) return invalid("Enter a salesperson name of 128 characters or fewer.");
    if (!email) return invalid("Enter a valid salesperson email address.");
    if (phone === null) return invalid("Enter a valid phone number of 7 to 15 digits, or leave it blank.");
    return {
      ok: true,
      value: { action: "profile", operationId, expectedUpdatedAt, expectedAuthUpdatedAt, name, email, phone },
    };
  }

  if (input.action === "password") {
    const password = passwordText(input.password);
    if (!password) return invalid("Enter a password between 8 and 256 characters.");
    return {
      ok: true,
      value: { action: "password", operationId, expectedUpdatedAt, expectedAuthUpdatedAt, password },
    };
  }

  if (input.action === "status") {
    if (input.status !== "active" && input.status !== "inactive") {
      return invalid("Choose active or inactive status.");
    }
    return {
      ok: true,
      value: { action: "status", operationId, expectedUpdatedAt, expectedAuthUpdatedAt, status: input.status },
    };
  }

  return invalid("Choose profile, password, or status management.");
}

export function validateEmployeeDelete(input: Record<string, unknown>): EmployeeValidationResult<EmployeeDeleteCommand> {
  const operationId = operationIdText(input.operationId);
  const expectedUpdatedAt = versionText(input.expectedUpdatedAt);
  const expectedAuthUpdatedAt = optionalVersionText(input.expectedAuthUpdatedAt);
  const confirmationEmail = requiredText(input.confirmationEmail, 320);
  if (!operationId) return invalid("A valid request ID is required.");
  if (!expectedUpdatedAt) return invalid("Refresh this salesperson before permanently deleting them.");
  if (expectedAuthUpdatedAt === null) return invalid("Refresh this salesperson's Auth identity before permanently deleting them.");
  if (!confirmationEmail) return invalid("Type the salesperson email to confirm permanent deletion.");
  return {
    ok: true,
    value: { action: "delete", operationId, expectedUpdatedAt, expectedAuthUpdatedAt, confirmationEmail },
  };
}

/**
 * Appwrite labels are security-sensitive and case-sensitive. Only the exact
 * dashboard-admin label protects an identity; similarly named labels do not.
 */
export function hasProtectedAdminIdentity(user: { labels?: unknown } | null | undefined) {
  return Array.isArray(user?.labels)
    && user.labels.some((label) => typeof label === "string" && label === "admin");
}

export function employeeDeletionConfirmationMatches(input: {
  confirmation: string;
  authEmail?: string | null;
  displayName: string;
}) {
  const actual = normalizedComparisonText(input.confirmation);
  const expected = normalizedComparisonText(input.authEmail ?? input.displayName);
  return Boolean(actual && expected && actual === expected);
}

export function employeeDeletionConfirmationLabel(authExists: boolean) {
  return authExists ? "the salesperson email" : "the employee name";
}

export function assignmentIsEffective(
  assignment: Record<string, unknown>,
  at: string | number | Date = Date.now(),
) {
  const instant = at instanceof Date ? at.valueOf() : typeof at === "number" ? at : new Date(at).valueOf();
  const start = new Date(String(assignment.effective_from ?? "")).valueOf();
  const end = assignment.effective_to ? new Date(String(assignment.effective_to)).valueOf() : null;
  return Number.isFinite(instant)
    && Number.isFinite(start)
    && start <= instant
    && (end === null || (Number.isFinite(end) && end > instant));
}

export function hasEffectiveSalespersonAssignment(
  assignments: Array<Record<string, unknown>>,
  salespersonRoleId: string,
  at: string | number | Date = Date.now(),
) {
  return assignments.some((assignment) => String(assignment.role_id ?? "") === salespersonRoleId
    && assignmentIsEffective(assignment, at));
}

export function employeeMutationDecision(
  expectedUpdatedAt: string,
  currentUpdatedAt: string,
  requestedStateAlreadyExists: boolean,
) {
  if (requestedStateAlreadyExists) return "noop" as const;
  return expectedUpdatedAt === currentUpdatedAt ? "write" as const : "conflict" as const;
}

export function summarizeEmployeeDependencies(counts: Iterable<EmployeeDependencyCount>): EmployeeDependencySummary {
  const dependencies = [...counts]
    .map((dependency) => ({ ...dependency, count: safeCount(dependency.count) }))
    .filter((dependency) => dependency.count > 0);
  const total = dependencies.reduce((sum, dependency) => sum + dependency.count, 0);
  return {
    blocked: total > 0,
    total,
    dependencies,
    message: total > 0
      ? `Permanent deletion is blocked by ${dependencies.map((item) => `${item.count} ${item.label}`).join(", ")}. Deactivate this salesperson to preserve operational history.`
      : "No operational history blocks permanent deletion.",
  };
}

/**
 * Produces the command persisted in an immutable audit receipt. Password
 * material is intentionally omitted in full: no secret and no password hash
 * may enter logs. The operation ID itself binds retries of a password reset.
 */
export function employeeCommandForAudit(command: EmployeeMutationCommand | EmployeeDeleteCommand): Record<string, unknown> {
  if (command.action === "password") {
    return {
      action: command.action,
      operationId: command.operationId,
      expectedUpdatedAt: command.expectedUpdatedAt,
      expectedAuthUpdatedAt: command.expectedAuthUpdatedAt,
    };
  }
  if (command.action === "delete") {
    return {
      action: command.action,
      operationId: command.operationId,
      expectedUpdatedAt: command.expectedUpdatedAt,
      expectedAuthUpdatedAt: command.expectedAuthUpdatedAt,
    };
  }
  if (command.action === "profile") {
    return {
      action: command.action,
      operationId: command.operationId,
      expectedUpdatedAt: command.expectedUpdatedAt,
      expectedAuthUpdatedAt: command.expectedAuthUpdatedAt,
      name: command.name,
      email: command.email,
      phone: command.phone,
    };
  }
  return {
    action: command.action,
    operationId: command.operationId,
    expectedUpdatedAt: command.expectedUpdatedAt,
    expectedAuthUpdatedAt: command.expectedAuthUpdatedAt,
    status: command.status,
  };
}

export function employeeAuditReceiptJson(
  command: EmployeeMutationCommand | EmployeeDeleteCommand,
  result: Record<string, unknown> = {},
) {
  return canonicalJson({ command: employeeCommandForAudit(command), result });
}

export function employeeAuditReceiptMatches(
  row: AuditRow,
  expected: {
    actorUserId: string;
    action: string;
    employeeId: string;
    command: EmployeeMutationCommand | EmployeeDeleteCommand;
  },
) {
  if (String(row.actor_user_id ?? "") !== expected.actorUserId
    || String(row.action ?? "") !== expected.action
    || String(row.entity_type ?? "") !== "employee"
    || String(row.entity_id ?? "") !== expected.employeeId) return false;
  try {
    const stored = JSON.parse(String(row.after_json ?? "{}")) as { command?: unknown };
    return canonicalJson(stored.command) === canonicalJson(employeeCommandForAudit(expected.command));
  } catch {
    return false;
  }
}

export function employeeAuditReceiptResult(row: AuditRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(row.after_json ?? "{}")) as { result?: unknown };
    return parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
      ? parsed.result as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function employeeProfileMatches(
  command: EmployeeProfileCommand,
  employee: Record<string, unknown>,
  user: { name?: unknown; email?: unknown },
) {
  return String(employee.display_name ?? "").trim() === command.name
    && optionalString(employee.phone) === command.phone
    && String(user.name ?? "").trim() === command.name
    && String(user.email ?? "").trim().toLowerCase() === command.email;
}

export function employeeStatusMatches(
  status: "active" | "inactive",
  employee: Record<string, unknown>,
  user: { status?: unknown } | null,
) {
  const active = status === "active";
  return String(employee.status ?? "") === status
    && (user === null ? !active : user.status === active);
}

function operationIdText(value: unknown) {
  return typeof value === "string" && OPERATION_ID_PATTERN.test(value.trim()) ? value.trim() : "";
}

function versionText(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 40) return "";
  return Number.isNaN(new Date(value).valueOf()) ? "" : value;
}

function optionalVersionText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return "";
  return versionText(value) || null;
}

function requiredText(value: unknown, maximum: number) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : "";
}

function emailText(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 320 && EMAIL_PATTERN.test(normalized) ? normalized : "";
}

function passwordText(value: unknown) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 256
    && /\S/.test(value)
    ? value
    : "";
}

function phoneText(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return "";
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

function normalizedComparisonText(value: string) {
  return value.trim().toLocaleLowerCase("en");
}

function safeCount(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function optionalString(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
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

function invalid<T>(error: string): EmployeeValidationResult<T> {
  return { ok: false, error };
}

export type EmployeeRow = Models.Row & Record<string, unknown>;
