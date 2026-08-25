export type OperationErrorKind = "connection" | "auth" | "validation" | "conflict" | "server";

export type OutboxOperation = {
  type: string;
  path: string;
  body?: Record<string, unknown>;
  fields?: Record<string, string>;
};

export type OutboxRecord<Operation extends OutboxOperation = OutboxOperation> = {
  id: string;
  employeeId: string;
  state: "pending" | "syncing" | "failed" | "confirmed";
  createdAt: string;
  attempts: number;
  operation?: Operation;
  error?: string;
  errorKind?: OperationErrorKind;
  httpStatus?: number;
  retryable?: boolean;
  nextAttemptAt?: string;
};

export type RetryDecision = {
  errorKind: OperationErrorKind;
  retryable: boolean;
  nextAttemptAt?: string;
};

export type DurableOutboxController<RecordType> = {
  update: (transform: (records: RecordType[]) => RecordType[]) => Promise<RecordType[]>;
  persistCurrent: () => Promise<RecordType[]>;
};

/**
 * Serializes durable queue mutations. A new queue is published to application
 * state only after persistence succeeds, so UI success can never get ahead of
 * the recoverable on-device copy.
 */
export function createDurableOutboxController<RecordType>({
  readCurrent,
  persist,
  publish,
}: {
  readCurrent: () => readonly RecordType[];
  persist: (records: readonly RecordType[]) => Promise<void>;
  publish: (records: RecordType[]) => void;
}): DurableOutboxController<RecordType> {
  let mutation: Promise<void> = Promise.resolve();

  const schedule = <Value>(operation: () => Promise<Value>) => {
    const result = mutation.then(operation);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    update(transform) {
      return schedule(async () => {
        const next = transform([...readCurrent()]);
        await persist(next);
        publish(next);
        return next;
      });
    },
    persistCurrent() {
      return schedule(async () => {
        const current = [...readCurrent()];
        await persist(current);
        return current;
      });
    },
  };
}

function operationValue(operation: OutboxOperation, key: string) {
  const value = operation.fields?.[key] ?? operation.body?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/**
 * Returns the server-side identity of an operation. Visit identity is the
 * visit ID (not the upload attempt ID), preventing two evidence uploads for
 * the same marked place after process recovery. Other writes use their
 * explicit idempotency key.
 */
export function operationIdentity(operation: OutboxOperation | undefined) {
  if (!operation) return "";
  const visitId = operation.type.startsWith("visit_") ? operationValue(operation, "visitId") : "";
  if (visitId) return `visit:${visitId}`;
  const idempotencyKey = operationValue(operation, "idempotencyKey");
  return idempotencyKey ? `${operation.type}:${operation.path}:${idempotencyKey}` : "";
}

export function findEquivalentOutboxRecord<RecordType extends OutboxRecord>(
  records: readonly RecordType[],
  candidate: RecordType,
) {
  const identity = operationIdentity(candidate.operation);
  if (!identity) return undefined;
  return records.find((record) => (
    record.employeeId === candidate.employeeId
    && operationIdentity(record.operation) === identity
  ));
}

export function appendUniqueOutboxRecord<RecordType extends OutboxRecord>(
  records: readonly RecordType[],
  candidate: RecordType,
) {
  return findEquivalentOutboxRecord(records, candidate) ? [...records] : [...records, candidate];
}

/** Restores a durable queue after a crash and removes replay duplicates. */
export function normalizeRestoredOutbox<RecordType extends OutboxRecord>(records: readonly RecordType[]) {
  const normalized: RecordType[] = [];
  const identities = new Map<string, number>();

  for (const raw of records) {
    const attempts = Number.isSafeInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0;
    const recovered = {
      ...raw,
      attempts,
      ...(raw.state === "syncing" ? { state: "pending" as const } : {}),
      ...(raw.state === "failed" && raw.retryable === undefined
        ? { retryable: raw.errorKind === "connection" || raw.errorKind === "server" }
        : {}),
    } as RecordType;
    const identity = operationIdentity(recovered.operation);
    if (!identity) {
      normalized.push(recovered);
      continue;
    }
    const scopedIdentity = `${recovered.employeeId}:${identity}`;
    const duplicateIndex = identities.get(scopedIdentity);
    if (duplicateIndex === undefined) {
      identities.set(scopedIdentity, normalized.length);
      normalized.push(recovered);
      continue;
    }

    // A confirmed copy is authoritative. Otherwise retain the older record,
    // which owns the first durable idempotency key and evidence references.
    const existing = normalized[duplicateIndex]!;
    if (existing.state !== "confirmed" && recovered.state === "confirmed") {
      normalized[duplicateIndex] = recovered;
    }
  }
  return normalized;
}

export function classifyOperationFailure(status: number): OperationErrorKind {
  if (status === 401) return "auth";
  if (status === 409) return "conflict";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "server";
  if (status >= 400) return "validation";
  return "connection";
}

export function operationRetryDecision({
  status,
  attempts,
  retryAfterMs,
  nowMs = Date.now(),
  random = Math.random,
}: {
  status: number;
  attempts: number;
  retryAfterMs?: number;
  nowMs?: number;
  random?: () => number;
}): RetryDecision {
  const errorKind = classifyOperationFailure(status);
  const retryable = errorKind === "connection" || errorKind === "server";
  if (!retryable) return { errorKind, retryable: false };

  const exponent = Math.max(0, Math.min(7, Math.floor(attempts) - 1));
  const exponentialMs = Math.min(120_000, 1_000 * 2 ** exponent);
  // Equal jitter prevents a fleet of phones from retrying at the same instant
  // while keeping the first retry quick (500-1000 ms).
  const jitteredMs = Math.round(exponentialMs / 2 + exponentialMs / 2 * Math.min(1, Math.max(0, random())));
  const delayMs = Math.max(jitteredMs, Math.max(0, retryAfterMs ?? 0));
  return {
    errorKind,
    retryable: true,
    nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
  };
}

export function canAttemptOutboxRecord(
  record: OutboxRecord,
  { force = false, nowMs = Date.now() }: { force?: boolean; nowMs?: number } = {},
) {
  if (!record.operation || record.state === "confirmed" || record.state === "syncing") return false;
  if (force) return true;
  if (record.state === "failed" && record.retryable === false) return false;
  if (!record.nextAttemptAt) return true;
  const nextAttempt = new Date(record.nextAttemptAt).valueOf();
  return !Number.isFinite(nextAttempt) || nextAttempt <= nowMs;
}

export function selectOutboxCandidates<RecordType extends OutboxRecord>(
  records: readonly RecordType[],
  employeeId: string,
  options: { force?: boolean; nowMs?: number; onlyId?: string } = {},
) {
  return records
    .filter((record) => (
      record.employeeId === employeeId
      && (!options.onlyId || record.id === options.onlyId)
      && canAttemptOutboxRecord(record, options)
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * A 401 is permanent for the credential that received it, but the saved work
 * becomes eligible again after the same employee establishes a fresh session.
 * Other validation/conflict failures remain unchanged for deliberate review.
 */
export function resumeAuthFailedOutboxRecords<RecordType extends OutboxRecord>(
  records: readonly RecordType[],
  employeeId: string,
) {
  return records.map((record) => (
    record.employeeId === employeeId
      && record.state === "failed"
      && record.errorKind === "auth"
      ? {
        ...record,
        state: "pending" as const,
        error: undefined,
        errorKind: undefined,
        httpStatus: undefined,
        retryable: undefined,
        nextAttemptAt: undefined,
      }
      : record
  ));
}

export function summarizeOutbox(records: readonly OutboxRecord[], employeeId: string) {
  const scoped = records.filter((record) => record.employeeId === employeeId);
  const confirmed = scoped.filter((record) => record.state === "confirmed").length;
  const syncing = scoped.filter((record) => record.state === "syncing").length;
  const failed = scoped.filter((record) => record.state === "failed").length;
  const needsAttention = scoped.filter((record) => record.state === "failed" && record.retryable === false).length;
  return {
    total: scoped.length,
    confirmed,
    pending: scoped.length - confirmed,
    syncing,
    failed,
    needsAttention,
    progress: scoped.length === 0 ? 1 : confirmed / scoped.length,
  };
}
