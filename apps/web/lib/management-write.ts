import { createHash } from "node:crypto";
import type { TablesDB } from "node-appwrite";

const HASH_LENGTH = 24;

export function stableManagementId(prefix: string, ...parts: unknown[]) {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "row";
  const digest = createHash("sha256")
    .update(parts.map(normalizePart).join("\u001f"))
    .digest("hex");
  return `${safePrefix}_${digest.slice(0, HASH_LENGTH)}`;
}

export function managementOperationKey(value: unknown, ...fallbackParts: unknown[]) {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^[a-zA-Z0-9._-]{1,64}$/.test(normalized)) return normalized;
  }
  return stableManagementId("op", ...fallbackParts);
}

export function managementAuditIdentity(action: string, entityId: string, operationKey: string) {
  return {
    auditId: stableManagementId("audit", action, entityId, operationKey),
    correlationId: stableManagementId("corr", action, entityId, operationKey),
  };
}

export function appwriteErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? Number(error.code)
    : 0;
}

export function isAppwriteConflict(error: unknown) {
  return appwriteErrorCode(error) === 409;
}

export function isAppwriteNotFound(error: unknown) {
  return appwriteErrorCode(error) === 404;
}

export function removalLeavesUnrestricted(activeTerritoryIds: Iterable<string>, territoryId: string) {
  const remaining = new Set([...activeTerritoryIds].filter(Boolean));
  remaining.delete(territoryId);
  return remaining.size === 0;
}

export function salesAreaDeletionAssignmentPlan(
  assignments: Array<Record<string, unknown> & { $id: string }>,
  territoryId: string,
  at: string,
) {
  const activeAssignments = assignments.filter((assignment) => assignmentIsEffectiveAt(assignment, at));
  const targetAssignments = activeAssignments.filter((assignment) => String(assignment.territory_id || "") === territoryId);
  const rolePairs = new Map<string, { employeeId: string; roleId: string }>();
  for (const assignment of targetAssignments) {
    const employeeId = String(assignment.employee_id || "");
    const roleId = String(assignment.role_id || "");
    if (employeeId && roleId) rolePairs.set(`${employeeId}:${roleId}`, { employeeId, roleId });
  }
  const rolesToRetain = [...rolePairs.values()].filter(({ employeeId, roleId }) => !activeAssignments.some((assignment) => (
    String(assignment.employee_id || "") === employeeId
    && String(assignment.role_id || "") === roleId
    && String(assignment.territory_id || "") !== territoryId
  )));
  return { targetAssignments, rolesToRetain };
}

export function optimisticWriteDecision(
  expectedVersion: string,
  currentVersion: string,
  requestedStateAlreadyExists: boolean,
) {
  if (requestedStateAlreadyExists) return "replay" as const;
  if (expectedVersion && expectedVersion !== currentVersion) return "conflict" as const;
  return "write" as const;
}

export async function rowExists(db: TablesDB, databaseId: string, tableId: string, rowId: string) {
  try {
    await db.getRow({ databaseId, tableId, rowId });
    return true;
  } catch (error) {
    if (isAppwriteNotFound(error)) return false;
    throw error;
  }
}

export async function runManagementTransaction<T>(
  db: TablesDB,
  operation: (transactionId: string) => Promise<T>,
) {
  const transaction = await db.createTransaction({ ttl: 60 });
  try {
    const result = await operation(transaction.$id);
    await db.updateTransaction({ transactionId: transaction.$id, commit: true });
    return result;
  } catch (error) {
    await db.updateTransaction({ transactionId: transaction.$id, rollback: true }).catch(() => undefined);
    throw error;
  }
}

export async function runManagementTransactionWithRetry<T>(
  db: TablesDB,
  operation: (transactionId: string, attempt: number) => Promise<T>,
  maximumAttempts = 5,
) {
  const attempts = Math.max(1, Math.floor(maximumAttempts));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runManagementTransaction(db, (transactionId) => operation(transactionId, attempt));
    } catch (error) {
      lastError = error;
      if (!isAppwriteConflict(error) || attempt === attempts) throw error;
    }
  }
  throw lastError;
}

function normalizePart(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function assignmentIsEffectiveAt(assignment: Record<string, unknown>, at: string) {
  const timestamp = new Date(at).valueOf();
  const startsAt = new Date(String(assignment.effective_from || "")).valueOf();
  const endsAt = assignment.effective_to ? new Date(String(assignment.effective_to)).valueOf() : null;
  return Number.isFinite(timestamp) && Number.isFinite(startsAt) && startsAt <= timestamp
    && (endsAt === null || (Number.isFinite(endsAt) && endsAt > timestamp));
}
