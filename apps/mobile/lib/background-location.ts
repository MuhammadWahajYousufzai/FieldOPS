import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

export const LOCATION_QUEUE_KEY = "fieldops-location-outbox-v1";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
let queueMutation: Promise<void> = Promise.resolve();

export type QueuedLocation = {
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
    return Array.isArray(value) ? value : [];
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

export async function locationQueueCount() {
  return (await readQueue()).length;
}

export async function queueLocationObjects(locations: Location.LocationObject[], source: QueuedLocation["source"] = "foreground") {
  if (locations.length === 0) return;
  const additions = locations.map((location) => ({
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
  await mutateQueue((current) => [...current, ...additions].slice(-20_000));
}

export async function flushLocationQueue(token?: string): Promise<number> {
  if (!token) return 0;
  const queue = await readQueue();
  if (queue.length === 0) return 0;
  const batch = queue.slice(0, 100);
  try {
    const response = await fetch(`${API_BASE}/locations/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ points: batch }),
    });
    if (!response.ok) return 0;
    const result = await response.json() as { confirmed?: string[] };
    const confirmed = new Set(result.confirmed ?? batch.map((point) => point.idempotencyKey));
    await mutateQueue((latest) => latest.filter((point) => !confirmed.has(point.idempotencyKey)));
    return confirmed.size;
  } catch {
    return 0;
  }
}
