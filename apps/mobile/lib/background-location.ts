import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { createKeyedSingleFlight, drainLocationOutbox } from "./location-outbox";
import { fetchWithTimeout } from "./network";

export const LOCATION_QUEUE_KEY = "fieldops-location-outbox-v1";
export const LEGACY_LOCATION_TASK = "fieldops-minute-route-v1";

const LEGACY_TRACKING_SESSION_KEY = "fieldops-tracking-session-v1";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
let queueMutation: Promise<void> = Promise.resolve();
const locationFlushes = createKeyedSingleFlight<string, number>();
const lastLocationSyncErrors = new Map<string, string>();

/**
 * Earlier TestFlight builds registered a persistent Expo background-location
 * task. iOS keeps that native registration across app updates, even though the
 * current FieldOPS route tracker is foreground-only. Build 20 restores the
 * native capability long enough to launch and removes the obsolete task here.
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
  source: "foreground";
  syncRejectedAt?: string;
  syncError?: string;
};

function pointId(timestamp: number) {
  return `loc_${Math.round(timestamp).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<QueuedLocation[]> {
  try {
    const saved = await AsyncStorage.getItem(LOCATION_QUEUE_KEY);
    const value = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(value)) return [];
    // Version 1 points created before employee scoping are intentionally
    // discarded. Sending one of those points after another user signs in
    // would attribute GPS evidence to the wrong employee.
    return value.filter((point): point is QueuedLocation => (
      Boolean(point)
      && typeof point === "object"
      && typeof point.employeeId === "string"
      && point.employeeId.length > 0
      && typeof point.idempotencyKey === "string"
    ));
  } catch {
    return [];
  }
}

async function mutateQueue(update: (current: QueuedLocation[]) => QueuedLocation[]) {
  const operation = queueMutation.then(async () => {
    const current = await readQueue();
    await AsyncStorage.setItem(LOCATION_QUEUE_KEY, JSON.stringify(update(current)));
  });
  queueMutation = operation.catch(() => undefined);
  await operation;
}

export async function locationQueueCount(employeeId?: string) {
  if (!employeeId) return 0;
  return (await readQueue()).filter((point) => point.employeeId === employeeId).length;
}

export async function locationQueueStats(employeeId?: string) {
  if (!employeeId) return { pending: 0, rejected: 0, error: "" };
  const points = (await readQueue()).filter((point) => point.employeeId === employeeId);
  return {
    pending: points.filter((point) => !point.syncRejectedAt).length,
    rejected: points.filter((point) => Boolean(point.syncRejectedAt)).length,
    error: lastLocationSyncErrors.get(employeeId) ?? "",
  };
}

export async function clearRejectedLocationPoints(employeeId: string) {
  await mutateQueue((current) => current.filter((point) => point.employeeId !== employeeId || !point.syncRejectedAt));
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
    idempotencyKey: pointId(location.timestamp),
    capturedAt: new Date(location.timestamp).toISOString(),
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: Math.max(0, location.coords.accuracy ?? 0),
    altitude: location.coords.altitude ?? null,
    speed: location.coords.speed ?? null,
    heading: location.coords.heading ?? null,
    source,
  }));
  await mutateQueue((current) => [...current, ...additions]);
}

export async function flushLocationQueue(employeeId?: string, token?: string): Promise<number> {
  if (!employeeId || !token) return 0;
  return locationFlushes.run(employeeId, async () => {
    lastLocationSyncErrors.delete(employeeId);
    return drainLocationOutbox({
      readPending: async () => (
        await readQueue()
      ).filter((point) => point.employeeId === employeeId && !point.syncRejectedAt),
      sendBatch: async (batch) => {
        const response = await fetchWithTimeout(`${API_BASE}/locations/batch`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ points: batch }),
        });
        if (!response.ok) throw new Error(`Location sync returned ${response.status}.`);
        return response.json();
      },
      removeConfirmed: (confirmed) => mutateQueue((latest) => latest.filter((point) => (
        point.employeeId !== employeeId || !confirmed.has(point.idempotencyKey)
      ))),
      quarantineRejected: (rejected) => mutateQueue((latest) => latest.map((point) => (
        point.employeeId === employeeId && rejected.has(point.idempotencyKey)
          ? { ...point, syncRejectedAt: new Date().toISOString(), syncError: rejected.get(point.idempotencyKey) }
          : point
      ))),
      onError: (error) => {
        lastLocationSyncErrors.set(employeeId, error instanceof Error ? error.message : "Route points could not reach the server.");
      },
    });
  });
}
