import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

export const LOCATION_TASK = "fieldops-minute-route-v1";
export const LOCATION_QUEUE_KEY = "fieldops-location-outbox-v1";
export const TRACKING_SESSION_KEY = "fieldops-tracking-session-v1";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";

export type QueuedLocation = {
  idempotencyKey: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  source: "background" | "foreground";
};

type TrackingSession = {
  token: string;
  employeeId: string;
  workActive: boolean;
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

export async function locationQueueCount() {
  return (await readQueue()).length;
}

export async function queueLocationObjects(locations: Location.LocationObject[], source: QueuedLocation["source"] = "background") {
  if (locations.length === 0) return;
  const current = await readQueue();
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
  await AsyncStorage.setItem(LOCATION_QUEUE_KEY, JSON.stringify([...current, ...additions].slice(-20_000)));
}

export async function flushLocationQueue(token?: string): Promise<number> {
  const session = token ? null : await readTrackingSession();
  const authToken = token ?? session?.token;
  if (!authToken) return 0;
  const queue = await readQueue();
  if (queue.length === 0) return 0;
  const batch = queue.slice(0, 100);
  try {
    const response = await fetch(`${API_BASE}/locations/batch`, {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ points: batch }),
    });
    if (!response.ok) return 0;
    const result = await response.json() as { confirmed?: string[] };
    const confirmed = new Set(result.confirmed ?? batch.map((point) => point.idempotencyKey));
    const latest = await readQueue();
    await AsyncStorage.setItem(LOCATION_QUEUE_KEY, JSON.stringify(latest.filter((point) => !confirmed.has(point.idempotencyKey))));
    return confirmed.size;
  } catch {
    return 0;
  }
}

async function readTrackingSession(): Promise<TrackingSession | null> {
  try {
    const saved = await AsyncStorage.getItem(TRACKING_SESSION_KEY);
    if (!saved) return null;
    const value = JSON.parse(saved) as TrackingSession;
    return value?.token && value?.employeeId ? value : null;
  } catch {
    return null;
  }
}

export async function setTrackingSession(session: Omit<TrackingSession, "workActive">, workActive: boolean) {
  await AsyncStorage.setItem(TRACKING_SESSION_KEY, JSON.stringify({ ...session, workActive }));
}

export async function clearTrackingSession() {
  await AsyncStorage.removeItem(TRACKING_SESSION_KEY);
}

export async function startRouteTracking(session: Omit<TrackingSession, "workActive">) {
  await setTrackingSession(session, true);
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 60_000,
    distanceInterval: 0,
    deferredUpdatesInterval: 60_000,
    deferredUpdatesDistance: 0,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.OtherNavigation,
    showsBackgroundLocationIndicator: true,
    foregroundService: Platform.OS === "android" ? {
      notificationTitle: "FieldOPS work in progress",
      notificationBody: "Your work route is being recorded for management.",
      notificationColor: "#D8A629",
      killServiceOnDestroy: false,
    } : undefined,
  });
}

export async function stopRouteTracking() {
  const session = await readTrackingSession();
  if (session) await setTrackingSession(session, false);
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const session = await readTrackingSession();
  if (!session?.workActive) return;
  const locations = (data as { locations?: Location.LocationObject[] }).locations ?? [];
  await queueLocationObjects(locations, "background");
  await flushLocationQueue(session.token);
});
