import AsyncStorage from "@react-native-async-storage/async-storage";
import { normalizeRouteTrackingPolicy, type RouteTrackPoint, type RouteTrackingPolicy } from "@fieldops/domain";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
  backgroundSessionIsCurrent,
  secureBackgroundTokenForEmployee,
  selectBackgroundRouteLocations,
} from "./background-route-policy";
import {
  MAX_LOCATION_QUEUE_ITEMS,
  authenticationAttemptWasReplaced,
  canAttemptLocationItem,
  createLocationQueueStoragePlan,
  createKeyedTrailingSingleFlight,
  deduplicateLocationItems,
  deterministicLocationKey,
  drainLocationOutbox,
  restoreLocationQueueChunks,
} from "./location-outbox";
import { fetchWithTimeout, retryAfterDelayMs } from "./network";
import { operationRetryDecision } from "./operation-outbox";
import { readSecureMobileSession } from "./secure-session";

export const LOCATION_QUEUE_KEY = "fieldops-location-outbox-v1";
export const LOCATION_QUEUE_MANIFEST_KEY = "fieldops-location-outbox-v2-manifest";
export const LEGACY_LOCATION_TASK = "fieldops-minute-route-v1";
export const ACTIVE_ROUTE_TASK = "fieldops-active-route-v2";

const LEGACY_TRACKING_SESSION_KEY = "fieldops-tracking-session-v1";
const ACTIVE_TRACKING_SESSION_KEY = "fieldops-active-route-session-v2";
const BACKGROUND_ROUTE_PREFERENCE_KEY = "fieldops-screen-lock-route-preference-v1";
const LOCATION_QUEUE_CHUNK_PREFIX = "fieldops-location-outbox-v2-chunk-";
const LOCATION_QUEUE_FAULT_KEY = "fieldops-location-outbox-v2-storage-fault";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
let queueMutation: Promise<void> = Promise.resolve();
let backgroundLifecycleMutation: Promise<void> = Promise.resolve();
const locationFlushes = createKeyedTrailingSingleFlight<string, number>();
const locationFlushRequests = new Map<string, {
  token: string;
  force: boolean;
  authenticationEpoch: number;
}>();
const locationAuthenticationEpochs = new Map<string, number>();
const lastLocationSyncErrors = new Map<string, string>();
let lastKnownLocationQueue: QueuedLocation[] = [];
let lastLocationStorageFault = "";

class LocationSyncError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = "LocationSyncError";
  }
}

/**
 * Earlier TestFlight builds registered a persistent Expo background-location
 * task under a retired name. iOS keeps native registrations across app
 * updates, so remove only that obsolete task without touching the separately
 * named, user-enabled continuity task.
 */
export async function cleanupLegacyBackgroundLocationTask() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LEGACY_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LEGACY_LOCATION_TASK);
    }
  } catch {
    // Continue to TaskManager cleanup; either API may already have removed it.
  }

  try {
    if (await TaskManager.isTaskRegisteredAsync(LEGACY_LOCATION_TASK)) {
      await TaskManager.unregisterTaskAsync(LEGACY_LOCATION_TASK);
    }
  } catch {
    // The restored Info.plist capability keeps launch safe even if cleanup is
    // temporarily unavailable. A later launch will retry this migration.
  }

  await AsyncStorage.removeItem(LEGACY_TRACKING_SESSION_KEY).catch(() => undefined);
}

export type QueuedLocation = {
  employeeId: string;
  idempotencyKey: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  source: "foreground" | "background";
  syncState?: "pending" | "syncing" | "failed";
  syncAttempts?: number;
  syncRetryable?: boolean;
  syncAuthPausedAt?: string;
  lastSyncAttemptAt?: string;
  nextSyncAttemptAt?: string;
  syncRejectedAt?: string;
  syncError?: string;
};

type LocationStorageFault = {
  version: 1;
  message: string;
  occurredAt: string;
};

class LocationQueueStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationQueueStorageError";
  }
}

type BackgroundRouteSession = {
  version: 2;
  active: true;
  employeeId: string;
  expiresAt: string;
  policy: RouteTrackingPolicy;
  lastAcceptedPoint: RouteTrackPoint | null;
  updatedAt: string;
};

type BackgroundRoutePreference = { employeeId: string; enabled: boolean };

export type BackgroundRouteStatus = {
  supported: boolean;
  permission: "granted" | "denied" | "undetermined";
  canAskAgain: boolean;
  enabled: boolean;
  running: boolean;
};

function serializeBackgroundLifecycle<T>(operation: () => Promise<T>) {
  const result = backgroundLifecycleMutation.then(operation);
  backgroundLifecycleMutation = result.then(() => undefined, () => undefined);
  return result;
}

function normalizeStoredRoutePoint(value: unknown): RouteTrackPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<RouteTrackPoint>;
  if (typeof point.capturedAt !== "string"
    || typeof point.latitude !== "number"
    || typeof point.longitude !== "number"
    || typeof point.accuracy !== "number") return null;
  return {
    capturedAt: point.capturedAt,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracy: point.accuracy,
    speed: typeof point.speed === "number" ? point.speed : null,
  };
}

async function readBackgroundRouteSession(): Promise<BackgroundRouteSession | null> {
  try {
    const saved = await AsyncStorage.getItem(ACTIVE_TRACKING_SESSION_KEY);
    if (!saved) return null;
    const value = JSON.parse(saved) as Partial<BackgroundRouteSession> & { token?: unknown };
    if (value.version !== 2 || !backgroundSessionIsCurrent(value)) {
      await AsyncStorage.removeItem(ACTIVE_TRACKING_SESSION_KEY).catch(() => undefined);
      return null;
    }
    const session: BackgroundRouteSession = {
      version: 2,
      active: true,
      employeeId: value.employeeId!,
      expiresAt: value.expiresAt!,
      policy: normalizeRouteTrackingPolicy(value.policy),
      lastAcceptedPoint: normalizeStoredRoutePoint(value.lastAcceptedPoint),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    };
    // Earlier v2 builds wrote the bearer token into AsyncStorage. Rewrite a
    // still-current record before using it so an app upgrade removes that
    // legacy credential; a failed rewrite makes the session unusable.
    if (Object.prototype.hasOwnProperty.call(value, "token")) {
      try {
        await AsyncStorage.setItem(ACTIVE_TRACKING_SESSION_KEY, JSON.stringify(session));
      } catch {
        await AsyncStorage.removeItem(ACTIVE_TRACKING_SESSION_KEY).catch(() => undefined);
        return null;
      }
    }
    return session;
  } catch {
    return null;
  }
}

async function readBackgroundRoutePreference(employeeId: string): Promise<boolean> {
  if (!employeeId) return false;
  try {
    const saved = await AsyncStorage.getItem(BACKGROUND_ROUTE_PREFERENCE_KEY);
    const value = saved ? JSON.parse(saved) as Partial<BackgroundRoutePreference> : null;
    return value?.employeeId === employeeId && value.enabled === true;
  } catch {
    return false;
  }
}

export async function setBackgroundRoutePreference(employeeId: string, enabled: boolean) {
  if (!employeeId) return;
  await AsyncStorage.setItem(BACKGROUND_ROUTE_PREFERENCE_KEY, JSON.stringify({ employeeId, enabled } satisfies BackgroundRoutePreference));
}

async function stopNativeActiveRouteTask() {
  let stopped = false;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(ACTIVE_ROUTE_TASK)) {
      await Location.stopLocationUpdatesAsync(ACTIVE_ROUTE_TASK);
    }
    stopped = true;
  } catch {
    // The persisted active-session record is removed first. If native cleanup
    // is temporarily unavailable, the task will see no session and self-stop.
  }
  if (!stopped) {
    try {
      if (await TaskManager.isTaskRegisteredAsync(ACTIVE_ROUTE_TASK)) {
        await TaskManager.unregisterTaskAsync(ACTIVE_ROUTE_TASK);
      }
    } catch {
      // A later foreground launch or task callback will retry cleanup.
    }
  }
}

export async function stopBackgroundRouteTracking() {
  return serializeBackgroundLifecycle(async () => {
    await AsyncStorage.removeItem(ACTIVE_TRACKING_SESSION_KEY).catch(() => undefined);
    await stopNativeActiveRouteTask();
  });
}

function sameRoutePolicy(a: RouteTrackingPolicy, b: RouteTrackingPolicy) {
  return a.sampleIntervalSeconds === b.sampleIntervalSeconds
    && a.distanceIntervalMeters === b.distanceIntervalMeters
    && a.maxAcceptedAccuracyMeters === b.maxAcceptedAccuracyMeters
    && a.stationaryJitterMeters === b.stationaryJitterMeters
    && a.segmentGapMinutes === b.segmentGapMinutes
    && a.maxPlausibleSpeedMps === b.maxPlausibleSpeedMps;
}

export async function startBackgroundRouteTracking({
  employeeId,
  token,
  expiresAt,
  policy: rawPolicy,
  lastAcceptedPoint = null,
}: {
  employeeId: string;
  token: string;
  expiresAt: string;
  policy: RouteTrackingPolicy;
  lastAcceptedPoint?: RouteTrackPoint | null;
}) {
  if (!backgroundSessionIsCurrent({ employeeId, expiresAt, active: true })
    || typeof token !== "string"
    || token.trim().length === 0) {
    throw new Error("The signed-in work session is not valid for route continuity.");
  }
  const policy = normalizeRouteTrackingPolicy(rawPolicy);
  return serializeBackgroundLifecycle(async () => {
    const current = await readBackgroundRouteSession();
    const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(ACTIVE_ROUTE_TASK).catch(() => false);
    if (current
      && current.employeeId === employeeId
      && current.expiresAt === expiresAt
      && sameRoutePolicy(current.policy, policy)
      && alreadyRunning) return;

    const next: BackgroundRouteSession = {
      version: 2,
      active: true,
      employeeId,
      expiresAt,
      policy,
      lastAcceptedPoint: current?.employeeId === employeeId
        ? current.lastAcceptedPoint ?? lastAcceptedPoint
        : lastAcceptedPoint,
      updatedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(ACTIVE_TRACKING_SESSION_KEY, JSON.stringify(next));
    try {
      await Location.startLocationUpdatesAsync(ACTIVE_ROUTE_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: policy.sampleIntervalSeconds * 1_000,
        distanceInterval: policy.distanceIntervalMeters,
        deferredUpdatesInterval: policy.sampleIntervalSeconds * 1_000,
        deferredUpdatesDistance: policy.distanceIntervalMeters,
        activityType: Location.ActivityType.OtherNavigation,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: "FieldOPS route recording",
          notificationBody: "Recording only while your work session is active",
          notificationColor: "#2563EB",
          killServiceOnDestroy: false,
        },
      });
    } catch (error) {
      await AsyncStorage.removeItem(ACTIVE_TRACKING_SESSION_KEY).catch(() => undefined);
      await stopNativeActiveRouteTask();
      throw error;
    }
  });
}

export async function requestBackgroundRoutePermission() {
  return Location.requestBackgroundPermissionsAsync();
}

export async function backgroundRouteStatus(employeeId: string): Promise<BackgroundRouteStatus> {
  const [supported, permission, enabled, running, activeSession] = await Promise.all([
    TaskManager.isAvailableAsync().catch(() => false),
    Location.getBackgroundPermissionsAsync().catch(() => null),
    readBackgroundRoutePreference(employeeId),
    Location.hasStartedLocationUpdatesAsync(ACTIVE_ROUTE_TASK).catch(() => false),
    readBackgroundRouteSession(),
  ]);
  return {
    supported,
    permission: permission?.granted ? "granted" : permission?.status === "denied" ? "denied" : "undetermined",
    canAskAgain: permission?.canAskAgain ?? true,
    enabled,
    running: running && activeSession?.employeeId === employeeId,
  };
}

function locationStorageMessage(error: unknown) {
  if (error instanceof RangeError) {
    return `Route storage reached its ${MAX_LOCATION_QUEUE_ITEMS.toLocaleString()}-point safety capacity. No saved points were deleted. Connect to the internet and send the route before recording more.`;
  }
  if (error instanceof LocationQueueStorageError) return error.message;
  return "Route storage could not be read or saved. No route points were deleted. Keep FieldOPS installed, free some phone storage, and try Check & send now.";
}

async function persistLocationStorageFault(error: unknown) {
  const message = locationStorageMessage(error);
  lastLocationStorageFault = message;
  const fault: LocationStorageFault = { version: 1, message, occurredAt: new Date().toISOString() };
  await AsyncStorage.setItem(LOCATION_QUEUE_FAULT_KEY, JSON.stringify(fault)).catch(() => undefined);
  return message;
}

async function clearLocationStorageFault() {
  lastLocationStorageFault = "";
  await AsyncStorage.removeItem(LOCATION_QUEUE_FAULT_KEY).catch(() => undefined);
}

async function readLocationStorageFault() {
  if (lastLocationStorageFault) return lastLocationStorageFault;
  try {
    const saved = await AsyncStorage.getItem(LOCATION_QUEUE_FAULT_KEY);
    const value = saved ? JSON.parse(saved) as Partial<LocationStorageFault> : null;
    if (value?.version === 1 && typeof value.message === "string") {
      lastLocationStorageFault = value.message;
      return value.message;
    }
  } catch {
    // The queue read itself will report an actionable storage error when the
    // underlying store is unavailable. A malformed optional fault record does
    // not make otherwise healthy route data unreadable.
  }
  return "";
}

function normalizeStoredLocationQueue(value: unknown, legacy: boolean): QueuedLocation[] {
  if (!Array.isArray(value)) throw new LocationQueueStorageError(
    "Saved route storage is unreadable. No points were overwritten; keep FieldOPS installed and contact support before clearing app data.",
  );
  const valid: QueuedLocation[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      throw new LocationQueueStorageError("Saved route storage contains an invalid point. It was preserved instead of being silently removed.");
    }
    const point = raw as Partial<QueuedLocation>;
    // Version 1 points created before employee scoping cannot safely be sent
    // after another user signs in. Preserve the established security migration
    // by omitting only those legacy, unattributable records.
    if ((!point.employeeId || typeof point.employeeId !== "string") && legacy) continue;
    if (typeof point.employeeId !== "string"
      || !point.employeeId
      || typeof point.idempotencyKey !== "string"
      || !/^[a-zA-Z0-9._-]{1,36}$/.test(point.idempotencyKey)) {
      throw new LocationQueueStorageError("Saved route storage contains an invalid identity. It was preserved instead of being silently removed.");
    }
    valid.push(point as QueuedLocation);
  }
  return deduplicateLocationItems(valid).map((point) => (
    point.syncState === "syncing" ? { ...point, syncState: "pending" as const } : point
  ));
}

async function readQueueStorage(): Promise<QueuedLocation[]> {
  const manifestSaved = await AsyncStorage.getItem(LOCATION_QUEUE_MANIFEST_KEY);
  if (manifestSaved) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestSaved);
    } catch {
      throw new LocationQueueStorageError("Saved route storage has an invalid manifest. Existing chunks were preserved for recovery.");
    }
    const chunkKeys = manifest && typeof manifest === "object" && Array.isArray((manifest as { chunkKeys?: unknown }).chunkKeys)
      ? (manifest as { chunkKeys: unknown[] }).chunkKeys.filter((key): key is string => typeof key === "string")
      : [];
    const storedChunks = chunkKeys.length > 0 ? await AsyncStorage.multiGet(chunkKeys) : [];
    const parsedChunks = new Map<string, unknown>();
    for (const [key, saved] of storedChunks) {
      if (saved === null) {
        parsedChunks.set(key, null);
        continue;
      }
      try {
        parsedChunks.set(key, JSON.parse(saved));
      } catch {
        parsedChunks.set(key, null);
      }
    }
    return normalizeStoredLocationQueue(restoreLocationQueueChunks(manifest, parsedChunks), false);
  }

  const legacySaved = await AsyncStorage.getItem(LOCATION_QUEUE_KEY);
  if (!legacySaved) return [];
  try {
    return normalizeStoredLocationQueue(JSON.parse(legacySaved), true);
  } catch (error) {
    if (error instanceof LocationQueueStorageError) throw error;
    throw new LocationQueueStorageError("The legacy route queue is unreadable. It was preserved instead of being overwritten.");
  }
}

function nextLocationQueueGeneration() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function persistQueueStorage(queue: QueuedLocation[]) {
  const plan = createLocationQueueStoragePlan(
    queue,
    nextLocationQueueGeneration(),
    LOCATION_QUEUE_CHUNK_PREFIX,
  );
  if (plan.chunks.length > 0) {
    await AsyncStorage.multiSet(plan.chunks.map((chunk) => [chunk.key, JSON.stringify(chunk.items)]));
  }
  // Publishing the manifest last is the commit point. Until this succeeds, the
  // previous generation (or the legacy single-key queue) remains authoritative.
  await AsyncStorage.setItem(LOCATION_QUEUE_MANIFEST_KEY, JSON.stringify(plan.manifest));
  await AsyncStorage.removeItem(LOCATION_QUEUE_KEY).catch(() => undefined);

  const retained = new Set(plan.manifest.chunkKeys);
  const obsolete = (await AsyncStorage.getAllKeys().catch(() => []))
    .filter((key) => key.startsWith(LOCATION_QUEUE_CHUNK_PREFIX) && !retained.has(key));
  if (obsolete.length > 0) await AsyncStorage.multiRemove(obsolete).catch(() => undefined);
  lastKnownLocationQueue = queue;
  await clearLocationStorageFault();
}

function serializeQueueStorage<T>(operation: () => Promise<T>) {
  const result = queueMutation.then(operation);
  queueMutation = result.then(() => undefined, () => undefined);
  return result;
}

function readQueue(): Promise<QueuedLocation[]> {
  return serializeQueueStorage(async () => {
    try {
      const queue = await readQueueStorage();
      lastKnownLocationQueue = queue;
      return queue;
    } catch (error) {
      const message = await persistLocationStorageFault(error);
      throw new LocationQueueStorageError(message);
    }
  });
}

async function mutateQueue(update: (current: QueuedLocation[]) => QueuedLocation[]) {
  await serializeQueueStorage(async () => {
    try {
      const current = await readQueueStorage();
      lastKnownLocationQueue = current;
      const next = deduplicateLocationItems(update(current));
      await persistQueueStorage(next);
    } catch (error) {
      const message = await persistLocationStorageFault(error);
      throw new LocationQueueStorageError(message);
    }
  });
}

export async function locationQueueCount(employeeId?: string) {
  if (!employeeId) return 0;
  return (await readQueue()).filter((point) => point.employeeId === employeeId).length;
}

export async function locationQueueStats(employeeId?: string) {
  if (!employeeId) return { pending: 0, rejected: 0, error: "" };
  let points: QueuedLocation[];
  try {
    points = (await readQueue()).filter((point) => point.employeeId === employeeId);
  } catch {
    points = lastKnownLocationQueue.filter((point) => point.employeeId === employeeId);
  }
  const storageFault = await readLocationStorageFault();
  return {
    pending: points.filter((point) => !point.syncRejectedAt).length,
    rejected: points.filter((point) => Boolean(point.syncRejectedAt)).length,
    error: storageFault
      || lastLocationSyncErrors.get(employeeId)
      || points.find((point) => point.syncState === "failed" && point.syncError)?.syncError
      || "",
  };
}

export async function clearRejectedLocationPoints(employeeId: string) {
  await mutateQueue((current) => current.filter((point) => point.employeeId !== employeeId || !point.syncRejectedAt));
}

/**
 * A 401 pauses only the affected employee's route points, even when a network
 * listener requests a forced flush. Call this after a fresh authenticated
 * session is established; validation-rejected points remain quarantined.
 */
export async function resumeLocationQueueAfterAuthentication(employeeId: string) {
  if (!employeeId) return;
  locationAuthenticationEpochs.set(employeeId, (locationAuthenticationEpochs.get(employeeId) ?? 0) + 1);
  await mutateQueue((current) => current.map((point) => (
    point.employeeId === employeeId && point.syncAuthPausedAt
      ? {
        ...point,
        syncState: "pending" as const,
        syncRetryable: undefined,
        syncAuthPausedAt: undefined,
        syncError: undefined,
        nextSyncAttemptAt: undefined,
      }
      : point
  )));
  lastLocationSyncErrors.delete(employeeId);
}

export async function queueLocationObjects(
  employeeId: string,
  locations: Location.LocationObject[],
  source: QueuedLocation["source"] = "foreground",
) {
  if (!employeeId) throw new Error("A signed-in employee is required before saving GPS points.");
  if (locations.length === 0) return;
  const additions = locations.map((location) => ({
    employeeId,
    idempotencyKey: deterministicLocationKey(employeeId, {
      timestamp: location.timestamp,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    }),
    capturedAt: new Date(location.timestamp).toISOString(),
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: Math.max(0, location.coords.accuracy ?? 0),
    altitude: location.coords.altitude ?? null,
    speed: location.coords.speed ?? null,
    heading: location.coords.heading ?? null,
    source,
    syncState: "pending" as const,
    syncAttempts: 0,
  }));
  await mutateQueue((current) => deduplicateLocationItems([...current, ...additions]));
}

export async function flushLocationQueue(
  employeeId?: string,
  token?: string,
  { force = false }: { force?: boolean } = {},
): Promise<number> {
  if (!employeeId || !token) return 0;
  const requested = locationFlushRequests.get(employeeId);
  const authenticationEpoch = locationAuthenticationEpochs.get(employeeId) ?? 0;
  locationFlushRequests.set(employeeId, {
    token,
    force: force || Boolean(requested?.force),
    authenticationEpoch,
  });
  return locationFlushes.run(employeeId, async () => {
    const latestRequest = locationFlushRequests.get(employeeId) ?? { token, force, authenticationEpoch };
    locationFlushRequests.set(employeeId, {
      token: latestRequest.token,
      force: false,
      authenticationEpoch: latestRequest.authenticationEpoch,
    });
    const requestToken = latestRequest.token;
    const requestForce = latestRequest.force;
    const requestAuthenticationEpoch = latestRequest.authenticationEpoch;
    const confirmed = await drainLocationOutbox({
      readPending: async () => (
        await readQueue()
      ).filter((point) => (
        point.employeeId === employeeId
        && canAttemptLocationItem(point, { force: requestForce })
      )),
      sendBatch: async (batch) => {
        const response = await fetchWithTimeout(`${API_BASE}/locations/batch`, {
          method: "POST",
          headers: { authorization: `Bearer ${requestToken}`, "content-type": "application/json" },
          body: JSON.stringify({ points: batch }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: unknown };
          const detail = typeof body.error === "string" ? ` ${body.error}` : "";
          throw new LocationSyncError(
            response.status === 401
              ? "Route upload paused until you sign in again. Every saved point remains on this phone."
              : `Location sync returned ${response.status}.${detail}`,
            response.status,
            retryAfterDelayMs(response.headers.get("retry-after")),
          );
        }
        return response.json();
      },
      removeConfirmed: async () => undefined,
      onBatchStart: (batch) => {
        const batchIds = new Set(batch.map((point) => point.idempotencyKey));
        const attemptedAt = new Date().toISOString();
        return mutateQueue((latest) => latest.map((point) => (
          point.employeeId === employeeId && batchIds.has(point.idempotencyKey)
            ? {
              ...point,
              syncState: "syncing",
              syncRetryable: undefined,
              syncAuthPausedAt: undefined,
              syncError: undefined,
              nextSyncAttemptAt: undefined,
              lastSyncAttemptAt: attemptedAt,
            }
            : point
        )));
      },
      applyDisposition: (disposition) => mutateQueue((latest) => latest.flatMap((point): QueuedLocation[] => {
        if (point.employeeId !== employeeId) return [point];
        if (disposition.confirmed.has(point.idempotencyKey)) return [];
        const rejection = disposition.rejected.get(point.idempotencyKey);
        if (rejection) return [{
          ...point,
          syncState: "failed",
          syncRetryable: false,
          syncAuthPausedAt: undefined,
          syncRejectedAt: new Date().toISOString(),
          syncError: rejection,
          nextSyncAttemptAt: undefined,
        }];
        return [point];
      })),
      onRetryableRejected: (rejected, batch) => {
        const retryIds = new Set(rejected.keys());
        const batchIds = new Set(batch.map((point) => point.idempotencyKey));
        const reason = [...rejected.values()][0] ?? "server_write_failed";
        lastLocationSyncErrors.set(employeeId, `Route sync paused: ${reason}.`);
        return mutateQueue((latest) => latest.map((point) => {
          if (point.employeeId !== employeeId || !batchIds.has(point.idempotencyKey)) return point;
          if (!retryIds.has(point.idempotencyKey)) {
            return point.syncState === "syncing" ? { ...point, syncState: "pending" as const } : point;
          }
          const attempts = (point.syncAttempts ?? 0) + 1;
          const retry = operationRetryDecision({ status: 503, attempts });
          return {
            ...point,
            syncState: "failed" as const,
            syncAttempts: attempts,
            syncRetryable: true,
            syncAuthPausedAt: undefined,
            syncError: rejected.get(point.idempotencyKey),
            nextSyncAttemptAt: retry.nextAttemptAt,
          };
        }));
      },
      onError: (error, batch) => {
        const status = error instanceof LocationSyncError ? error.status : 0;
        const staleAuthentication = status === 401 && authenticationAttemptWasReplaced(
          requestAuthenticationEpoch,
          locationAuthenticationEpochs.get(employeeId) ?? 0,
        );
        const message = status === 401
          ? "Route upload paused until you sign in again. Every saved point remains on this phone."
          : error instanceof Error ? error.message : "Route points could not reach the server.";
        if (!staleAuthentication) lastLocationSyncErrors.set(employeeId, message);
        if (!batch?.length) return;
        const batchIds = new Set(batch.map((point) => point.idempotencyKey));
        const authPausedAt = status === 401 && !staleAuthentication ? new Date().toISOString() : undefined;
        return mutateQueue((latest) => latest.map((point) => {
          if (point.employeeId !== employeeId || !batchIds.has(point.idempotencyKey)) return point;
          if (staleAuthentication) return {
            ...point,
            syncState: "pending" as const,
            syncRetryable: undefined,
            syncAuthPausedAt: undefined,
            syncError: undefined,
            nextSyncAttemptAt: undefined,
          };
          const attempts = (point.syncAttempts ?? 0) + 1;
          const retry = operationRetryDecision({
            status,
            attempts,
            retryAfterMs: error instanceof LocationSyncError ? error.retryAfterMs : undefined,
          });
          return {
            ...point,
            syncState: "failed" as const,
            syncAttempts: attempts,
            syncRetryable: retry.retryable,
            syncAuthPausedAt: authPausedAt,
            syncError: message,
            nextSyncAttemptAt: retry.nextAttemptAt,
          };
        }));
      },
    });
    const remaining = (await readQueue()).filter((point) => point.employeeId === employeeId && !point.syncRejectedAt);
    const failed = remaining.find((point) => point.syncState === "failed" && point.syncError);
    if (failed?.syncError) lastLocationSyncErrors.set(employeeId, failed.syncError);
    else if (confirmed > 0 || remaining.length === 0) lastLocationSyncErrors.delete(employeeId);
    return confirmed;
  });
}

type BackgroundLocationTaskData = { locations?: Location.LocationObject[] };

async function handleBackgroundRouteLocations(locations: Location.LocationObject[]) {
  const result = await serializeBackgroundLifecycle(async (): Promise<{
    flushRequest: { employeeId: string; token: string } | null;
  }> => {
    const session = await readBackgroundRouteSession();
    if (!session) {
      await AsyncStorage.removeItem(ACTIVE_TRACKING_SESSION_KEY).catch(() => undefined);
      // Stop while holding the same lifecycle lock used by start. Stopping
      // after releasing this lock lets a stale native callback shut down a
      // freshly started session that raced in immediately behind it.
      await stopNativeActiveRouteTask();
      return { flushRequest: null };
    }

    const secureSession = await readSecureMobileSession();
    const secureToken = secureBackgroundTokenForEmployee(secureSession, session.employeeId);
    if (!secureToken) {
      await AsyncStorage.removeItem(ACTIVE_TRACKING_SESSION_KEY).catch(() => undefined);
      await stopNativeActiveRouteTask();
      return { flushRequest: null };
    }

    const selected = selectBackgroundRouteLocations(
      locations,
      session.lastAcceptedPoint,
      session.policy,
    );
    if (selected.accepted.length === 0) return { flushRequest: null };

    await queueLocationObjects(session.employeeId, selected.accepted, "background");
    await AsyncStorage.setItem(ACTIVE_TRACKING_SESSION_KEY, JSON.stringify({
      ...session,
      lastAcceptedPoint: selected.lastAccepted,
      updatedAt: new Date().toISOString(),
    } satisfies BackgroundRouteSession));
    return {
      flushRequest: { employeeId: session.employeeId, token: secureToken },
    };
  });

  if (result.flushRequest) {
    await flushLocationQueue(result.flushRequest.employeeId, result.flushRequest.token).catch(() => undefined);
  }
}

// Expo must see the task definition in the global module scope. This is a new
// registration name; the one-time legacy cleanup above intentionally keeps
// removing fieldops-minute-route-v1 from older installs.
if (!TaskManager.isTaskDefined(ACTIVE_ROUTE_TASK)) {
  TaskManager.defineTask<BackgroundLocationTaskData>(ACTIVE_ROUTE_TASK, async ({ data, error }) => {
    if (error || !Array.isArray(data?.locations) || data.locations.length === 0) return;
    await handleBackgroundRouteLocations(data.locations).catch(() => undefined);
  });
}
