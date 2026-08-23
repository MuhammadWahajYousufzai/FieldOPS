import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { fetchWithTimeout } from "./network";

export const LOCATION_QUEUE_KEY = "fieldops-location-outbox-v1";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
let queueMutation: Promise<void> = Promise.resolve();
const activeFlushes = new Map<string, Promise<number>>();

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
  const inFlight = activeFlushes.get(employeeId);
  if (inFlight) return inFlight;
  const activeFlush = (async () => {
    const queue = (await readQueue()).filter((point) => point.employeeId === employeeId);
    if (queue.length === 0) return 0;
    const batch = queue.slice(0, 100);
    try {
      const response = await fetchWithTimeout(`${API_BASE}/locations/batch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ points: batch }),
      });
      if (!response.ok) return 0;
      const result = await response.json() as { confirmed?: string[] };
      const confirmed = new Set(result.confirmed ?? batch.map((point) => point.idempotencyKey));
      await mutateQueue((latest) => latest.filter((point) => (
        point.employeeId !== employeeId || !confirmed.has(point.idempotencyKey)
      )));
      return confirmed.size;
    } catch {
      return 0;
    }
  })();
  activeFlushes.set(employeeId, activeFlush);
  try {
    return await activeFlush;
  } finally {
    if (activeFlushes.get(employeeId) === activeFlush) activeFlushes.delete(employeeId);
  }
}
