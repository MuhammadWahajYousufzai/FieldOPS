export const LOCATION_BATCH_SIZE = 100;
export const MAX_LOCATION_BATCHES_PER_FLUSH = 5;

export type LocationOutboxItem = {
  idempotencyKey: string;
};

type DrainLocationOutboxOptions<Item extends LocationOutboxItem> = {
  readPending: () => Promise<Item[]>;
  sendBatch: (batch: Item[]) => Promise<unknown>;
  removeConfirmed: (confirmedIds: ReadonlySet<string>) => Promise<void>;
  quarantineRejected?: (rejectedIds: ReadonlyMap<string, string>) => Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  batchSize?: number;
  maxBatches?: number;
};

export type LocationBatchDisposition = {
  confirmed: Set<string>;
  rejected: Map<string, string>;
};

export function locationBatchDisposition(
  payload: unknown,
  submittedIds: readonly string[],
): LocationBatchDisposition | null {
  if (!payload || typeof payload !== "object" || !("confirmed" in payload)) return null;
  const confirmedValue = (payload as { confirmed?: unknown }).confirmed;
  const rejectedValue = (payload as { rejected?: unknown }).rejected ?? [];
  if (!Array.isArray(confirmedValue) || !Array.isArray(rejectedValue)) return null;

  const submitted = new Set(submittedIds);
  const confirmed = new Set<string>();
  for (const value of confirmedValue) {
    if (typeof value !== "string" || !submitted.has(value)) return null;
    confirmed.add(value);
  }

  const rejected = new Map<string, string>();
  for (const value of rejectedValue) {
    if (!value || typeof value !== "object") return null;
    const item = value as { idempotencyKey?: unknown; reason?: unknown; retryable?: unknown };
    if (typeof item.idempotencyKey !== "string"
      || !submitted.has(item.idempotencyKey)
      || confirmed.has(item.idempotencyKey)
      || typeof item.retryable !== "boolean") return null;
    if (!item.retryable) rejected.set(item.idempotencyKey, typeof item.reason === "string" ? item.reason : "invalid_point");
  }
  return { confirmed, rejected };
}

/**
 * A successful HTTP status is not itself proof that a point was stored. Only
 * an explicit array containing IDs from the submitted batch is accepted.
 */
export function confirmedLocationIds(
  payload: unknown,
  submittedIds: readonly string[],
): Set<string> | null {
  return locationBatchDisposition(payload, submittedIds)?.confirmed ?? null;
}

/**
 * Drains a bounded number of batches. Re-reading between batches ensures that
 * points queued while a flush is running are not lost and that only points
 * confirmed by the server are removed.
 */
export async function drainLocationOutbox<Item extends LocationOutboxItem>({
  readPending,
  sendBatch,
  removeConfirmed,
  quarantineRejected,
  onError,
  batchSize = LOCATION_BATCH_SIZE,
  maxBatches = MAX_LOCATION_BATCHES_PER_FLUSH,
}: DrainLocationOutboxOptions<Item>): Promise<number> {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const safeMaxBatches = Math.max(1, Math.floor(maxBatches));
  let confirmedCount = 0;

  for (let batchNumber = 0; batchNumber < safeMaxBatches; batchNumber += 1) {
    let pending: Item[];
    try {
      pending = await readPending();
    } catch (error) {
      await onError?.(error);
      break;
    }
    const batch = pending.slice(0, safeBatchSize);
    if (batch.length === 0) break;

    let payload: unknown;
    try {
      payload = await sendBatch(batch);
    } catch (error) {
      await onError?.(error);
      break;
    }
    const disposition = locationBatchDisposition(
      payload,
      batch.map((point) => point.idempotencyKey),
    );
    if (!disposition) {
      await onError?.(new Error("The server returned an invalid location confirmation."));
      break;
    }

    try {
      if (disposition.confirmed.size > 0) await removeConfirmed(disposition.confirmed);
      if (disposition.rejected.size > 0) {
        if (!quarantineRejected) break;
        await quarantineRejected(disposition.rejected);
      }
    } catch (error) {
      await onError?.(error);
      break;
    }
    confirmedCount += disposition.confirmed.size;
    if (disposition.confirmed.size === 0 && disposition.rejected.size === 0) {
      await onError?.(new Error("The server could not confirm these route points yet."));
      break;
    }
  }

  return confirmedCount;
}

export function createKeyedSingleFlight<Key, Value>() {
  const active = new Map<Key, Promise<Value>>();

  return {
    run(key: Key, operation: () => Promise<Value>): Promise<Value> {
      const existing = active.get(key);
      if (existing) return existing;

      let current: Promise<Value>;
      current = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (active.get(key) === current) active.delete(key);
        });
      active.set(key, current);
      return current;
    },
  };
}
