export const LOCATION_BATCH_SIZE = 100;
export const MAX_LOCATION_BATCHES_PER_FLUSH = 5;
export const LOCATION_STORAGE_CHUNK_SIZE = 200;
// At the most precise supported 5-second policy this still preserves more than
// a full day of continuous points. Typical 10-15 second field use retains
// several days while staying comfortably inside the enlarged Android store.
export const MAX_LOCATION_QUEUE_ITEMS = 25_000;

export type LocationOutboxItem = {
  idempotencyKey: string;
};

export type LocationQueueManifest = {
  version: 2;
  generation: string;
  count: number;
  chunkSize: typeof LOCATION_STORAGE_CHUNK_SIZE;
  chunkKeys: string[];
  updatedAt: string;
};

export type LocationQueueStoragePlan<Item> = {
  manifest: LocationQueueManifest;
  chunks: Array<{ key: string; items: Item[] }>;
};

/**
 * Builds small AsyncStorage values instead of one ever-growing JSON row. The
 * caller writes every chunk first and publishes the manifest last, so a failed
 * write leaves the previously committed generation readable.
 */
export function createLocationQueueStoragePlan<Item>(
  items: readonly Item[],
  generation: string,
  chunkKeyPrefix: string,
  updatedAt = new Date().toISOString(),
): LocationQueueStoragePlan<Item> {
  if (!generation || !chunkKeyPrefix) throw new Error("A queue generation and chunk prefix are required.");
  if (items.length > MAX_LOCATION_QUEUE_ITEMS) {
    throw new RangeError(`Route queue capacity is ${MAX_LOCATION_QUEUE_ITEMS} points.`);
  }

  const chunks: Array<{ key: string; items: Item[] }> = [];
  for (let index = 0; index < items.length; index += LOCATION_STORAGE_CHUNK_SIZE) {
    chunks.push({
      key: `${chunkKeyPrefix}${generation}-${chunks.length}`,
      items: items.slice(index, index + LOCATION_STORAGE_CHUNK_SIZE),
    });
  }
  return {
    manifest: {
      version: 2,
      generation,
      count: items.length,
      chunkSize: LOCATION_STORAGE_CHUNK_SIZE,
      chunkKeys: chunks.map((chunk) => chunk.key),
      updatedAt,
    },
    chunks,
  };
}

/** Validates the manifest and reassembles a committed queue generation. */
export function restoreLocationQueueChunks(
  rawManifest: unknown,
  chunksByKey: ReadonlyMap<string, unknown>,
) {
  if (!rawManifest || typeof rawManifest !== "object") throw new Error("Route queue manifest is invalid.");
  const manifest = rawManifest as Partial<LocationQueueManifest>;
  if (manifest.version !== 2
    || typeof manifest.generation !== "string"
    || !manifest.generation
    || !Number.isSafeInteger(manifest.count)
    || Number(manifest.count) < 0
    || Number(manifest.count) > MAX_LOCATION_QUEUE_ITEMS
    || manifest.chunkSize !== LOCATION_STORAGE_CHUNK_SIZE
    || !Array.isArray(manifest.chunkKeys)
    || manifest.chunkKeys.some((key) => typeof key !== "string" || !key)
    || new Set(manifest.chunkKeys).size !== manifest.chunkKeys.length
    || manifest.chunkKeys.length !== Math.ceil(Number(manifest.count) / LOCATION_STORAGE_CHUNK_SIZE)) {
    throw new Error("Route queue manifest is invalid.");
  }

  const restored: unknown[] = [];
  for (const key of manifest.chunkKeys) {
    const chunk = chunksByKey.get(key);
    if (!Array.isArray(chunk) || chunk.length > LOCATION_STORAGE_CHUNK_SIZE) {
      throw new Error("A route queue chunk is missing or invalid.");
    }
    restored.push(...chunk);
  }
  if (restored.length !== manifest.count) throw new Error("Route queue storage is incomplete.");
  return restored;
}

export type LocationRetryState = {
  syncRejectedAt?: string;
  syncRetryable?: boolean;
  syncAuthPausedAt?: string;
  nextSyncAttemptAt?: string;
};

/**
 * A response started with an older bearer credential must not pause work after
 * a newer authenticated session has already been established. The foreground
 * app advances the epoch before resuming the queue, so an in-flight 401 can be
 * recognized without persisting either credential in normal app storage.
 */
export function authenticationAttemptWasReplaced(requestEpoch: number, currentEpoch: number) {
  return requestEpoch !== currentEpoch;
}

export function canAttemptLocationItem(
  item: LocationRetryState,
  { force = false, nowMs = Date.now() }: { force?: boolean; nowMs?: number } = {},
) {
  if (item.syncRejectedAt || item.syncAuthPausedAt) return false;
  if (force) return true;
  if (item.syncRetryable === false) return false;
  if (!item.nextSyncAttemptAt) return true;
  const nextAttempt = new Date(item.nextSyncAttemptAt).valueOf();
  return !Number.isFinite(nextAttempt) || nextAttempt <= nowMs;
}

type DrainLocationOutboxOptions<Item extends LocationOutboxItem> = {
  readPending: () => Promise<Item[]>;
  sendBatch: (batch: Item[]) => Promise<unknown>;
  removeConfirmed: (confirmedIds: ReadonlySet<string>) => Promise<void>;
  quarantineRejected?: (rejectedIds: ReadonlyMap<string, string>) => Promise<void>;
  applyDisposition?: (disposition: LocationBatchDisposition) => Promise<void>;
  onBatchStart?: (batch: Item[]) => void | Promise<void>;
  onRetryableRejected?: (rejectedIds: ReadonlyMap<string, string>, batch: Item[]) => void | Promise<void>;
  onError?: (error: unknown, batch?: Item[]) => void | Promise<void>;
  onProgress?: (progress: { confirmed: number; attempted: number; batches: number }) => void | Promise<void>;
  batchSize?: number;
  maxBatches?: number;
};

export type LocationBatchDisposition = {
  confirmed: Set<string>;
  rejected: Map<string, string>;
  retryable: Map<string, string>;
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
  if (submitted.size !== submittedIds.length) return null;
  const confirmed = new Set<string>();
  for (const value of confirmedValue) {
    if (typeof value !== "string" || !submitted.has(value)) return null;
    confirmed.add(value);
  }

  const rejected = new Map<string, string>();
  const retryable = new Map<string, string>();
  const rejectedIds = new Set<string>();
  for (const value of rejectedValue) {
    if (!value || typeof value !== "object") return null;
    const item = value as { idempotencyKey?: unknown; reason?: unknown; retryable?: unknown };
    if (typeof item.idempotencyKey !== "string"
      || !submitted.has(item.idempotencyKey)
      || confirmed.has(item.idempotencyKey)
      || rejectedIds.has(item.idempotencyKey)
      || typeof item.retryable !== "boolean") return null;
    rejectedIds.add(item.idempotencyKey);
    const reason = typeof item.reason === "string" ? item.reason : item.retryable ? "server_write_failed" : "invalid_point";
    const target = item.retryable ? retryable : rejected;
    target.set(item.idempotencyKey, reason);
  }
  return { confirmed, rejected, retryable };
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
  applyDisposition,
  onBatchStart,
  onRetryableRejected,
  onError,
  onProgress,
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
      await onBatchStart?.(batch);
      payload = await sendBatch(batch);
    } catch (error) {
      await onError?.(error, batch);
      break;
    }
    const disposition = locationBatchDisposition(
      payload,
      batch.map((point) => point.idempotencyKey),
    );
    if (!disposition) {
      await onError?.(new Error("The server returned an invalid location confirmation."), batch);
      break;
    }

    try {
      if (applyDisposition) {
        await applyDisposition(disposition);
      } else {
        if (disposition.confirmed.size > 0) await removeConfirmed(disposition.confirmed);
        if (disposition.rejected.size > 0) {
          if (!quarantineRejected) break;
          await quarantineRejected(disposition.rejected);
        }
      }
    } catch (error) {
      await onError?.(error, batch);
      break;
    }
    confirmedCount += disposition.confirmed.size;
    await onProgress?.({ confirmed: confirmedCount, attempted: batch.length, batches: batchNumber + 1 });
    if (disposition.retryable.size > 0) {
      await onRetryableRejected?.(disposition.retryable, batch);
      break;
    }
    if (disposition.confirmed.size === 0 && disposition.rejected.size === 0) {
      await onError?.(new Error("The server could not confirm these route points yet."), batch);
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

/**
 * Coalesces concurrent drains and guarantees one trailing drain when new work
 * arrives during an active request. Multiple triggers still produce at most
 * two executions, preventing request storms on reconnect.
 */
export function createKeyedTrailingSingleFlight<Key, Value>() {
  type Flight = {
    promise: Promise<Value>;
    trailing?: () => Promise<Value>;
  };
  const active = new Map<Key, Flight>();

  return {
    run(key: Key, operation: () => Promise<Value>): Promise<Value> {
      const existing = active.get(key);
      if (existing) {
        existing.trailing = operation;
        return existing.promise;
      }

      const flight = {} as Flight;
      flight.promise = (async () => {
        let current = operation;
        let result!: Value;
        do {
          result = await current();
          const trailing = flight.trailing;
          flight.trailing = undefined;
          if (!trailing) {
            if (active.get(key) === flight) active.delete(key);
            return result;
          }
          current = trailing;
        } while (true);
      })().finally(() => {
        if (active.get(key) === flight) active.delete(key);
      });
      active.set(key, flight);
      return flight.promise;
    },
  };
}

export function deterministicLocationKey(
  employeeId: string,
  point: { timestamp: number; latitude: number; longitude: number },
) {
  const fingerprint = `${employeeId}|${Math.round(point.timestamp)}|${point.latitude.toFixed(7)}|${point.longitude.toFixed(7)}`;
  // FNV-1a is used only for a compact deterministic identifier, not security.
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `loc_${Math.round(point.timestamp).toString(36)}_${(hash >>> 0).toString(36)}`.slice(0, 36);
}

export function deduplicateLocationItems<Item extends LocationOutboxItem>(items: readonly Item[]) {
  const keys = new Set<string>();
  return items.filter((item) => {
    if (keys.has(item.idempotencyKey)) return false;
    keys.add(item.idempotencyKey);
    return true;
  });
}
