import "../global.css";

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import {
  distanceMeters,
  hasRequiredVisitEvidence,
  parseTerritoryBoundary,
  pointInAnyTerritory,
  type TerritoryBoundary,
} from "@fieldops/domain";
import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  Image,
  Linking,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import {
  flushLocationQueue,
  locationQueueCount,
  queueLocationObjects,
} from "../lib/background-location";

type Screen = "today" | "route" | "new_visit" | "visit" | "order" | "sync" | "profile";
type VisitStatus = "planned" | "active" | "completed";
type WorkState = "not_started" | "active" | "finished";
type Session = { token: string; expiresAt: string; employee: { id: string; name: string; code: string } };
type JsonOperation = { type: "json"; path: string; body: Record<string, unknown> };
type EvidenceAttachment = { uri: string; name: string; type: string };
type VisitUploadOperation = {
  type: "visit_submit" | "visit_complete";
  path: string;
  fields: Record<string, string>;
  photo: EvidenceAttachment;
  audio: EvidenceAttachment;
};
type OfflineOperation = JsonOperation | VisitUploadOperation;
type QueueItem = {
  id: string;
  label: string;
  state: "pending" | "syncing" | "failed" | "confirmed";
  createdAt: string;
  attempts: number;
  error?: string;
  operation?: OfflineOperation;
};
type Outlet = {
  routeId: string;
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  sequence: number;
  status: VisitStatus;
  notes: string;
  kind: "assigned" | "self";
  workDate: string;
  territoryId?: string;
};
type TerritoryInfo = { id: string; code: string; name: string; boundary: TerritoryBoundary | null };
type TerritoryPolicy = { mode: "unrestricted" | "restricted"; assignedCount: number; territories: TerritoryInfo[] };
type TerritoryPosition = "unrestricted" | "checking" | "inside" | "outside" | "boundary_missing";
type ActiveVisit = {
  id: string;
  outletId: string;
  checkIn?: Record<string, string>;
  outcome: string;
  notes: string;
  photo?: EvidenceAttachment;
  audio?: EvidenceAttachment;
};
type PermissionState = {
  foreground: boolean;
  camera: boolean;
  microphone: boolean;
  services: boolean;
};
type PersistedState = {
  session: Session | null;
  workState: WorkState;
  outlets: Outlet[];
  queue: QueueItem[];
  activeVisit: ActiveVisit | null;
  territoryPolicy: TerritoryPolicy;
};

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
export const STORAGE_KEY = "fieldops-production-state-v3";
const GEOFENCE_METERS = 70;
const emptyPermissions: PermissionState = {
  foreground: false,
  camera: false,
  microphone: false,
  services: false,
};
const unrestrictedTerritoryPolicy: TerritoryPolicy = { mode: "unrestricted", assignedCount: 0, territories: [] };

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function operationId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`.slice(0, 36);
}

function pakistanWorkDate(value = new Date()) {
  return new Date(value.valueOf() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeTerritoryPolicy(value: unknown): TerritoryPolicy {
  if (!value || typeof value !== "object") return unrestrictedTerritoryPolicy;
  const record = value as { mode?: unknown; assignedCount?: unknown; territories?: unknown };
  if (record.mode !== "restricted") return unrestrictedTerritoryPolicy;
  const territories = Array.isArray(record.territories)
    ? record.territories.flatMap((item): TerritoryInfo[] => {
      if (!item || typeof item !== "object") return [];
      const territory = item as { id?: unknown; code?: unknown; name?: unknown; boundary?: unknown };
      if (!territory.id || !territory.name) return [];
      return [{
        id: String(territory.id),
        code: String(territory.code ?? ""),
        name: String(territory.name),
        boundary: parseTerritoryBoundary(territory.boundary),
      }];
    })
    : [];
  const assignedCount = Math.max(Number(record.assignedCount) || territories.length, territories.length);
  return { mode: "restricted", assignedCount, territories };
}

function stringFields(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => (
    typeof item === "string" || typeof item === "number" ? [[key, String(item)]] : []
  )));
}

function normalizeAttachment(value: unknown): EvidenceAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<EvidenceAttachment>;
  if (!item.uri || !item.name || !item.type) return undefined;
  return { uri: item.uri, name: item.name, type: item.type };
}

function normalizeActiveVisit(value: unknown): ActiveVisit | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ActiveVisit>;
  if (!item.id || !item.outletId) return null;
  const checkIn = stringFields(item.checkIn);
  return {
    id: item.id,
    outletId: item.outletId,
    ...(Object.keys(checkIn).length > 0 ? { checkIn } : {}),
    outcome: typeof item.outcome === "string" ? item.outcome : "Order placed",
    notes: typeof item.notes === "string" ? item.notes : "",
    photo: normalizeAttachment(item.photo),
    audio: normalizeAttachment(item.audio),
  };
}

function visitIdFromCompletionPath(path: string) {
  return path.match(/^\/visits\/([^/]+)\/complete$/)?.[1] ?? "";
}

function submissionFieldsFromLegacy(
  visitId: string,
  checkIn: Record<string, unknown> | undefined,
  completion: Record<string, string>,
) {
  const checkInFields = stringFields(checkIn);
  return {
    visitId,
    visitType: checkInFields.visitType ?? "",
    outletId: checkInFields.outletId ?? "",
    routeId: checkInFields.routeId ?? "",
    customerName: checkInFields.customerName ?? "",
    customerAddress: checkInFields.customerAddress ?? "",
    checkInLatitude: checkInFields.latitude ?? "",
    checkInLongitude: checkInFields.longitude ?? "",
    checkInAccuracy: checkInFields.accuracy ?? "",
    checkInCapturedAt: checkInFields.capturedAt ?? "",
    completionLatitude: completion.latitude ?? "",
    completionLongitude: completion.longitude ?? "",
    completionAccuracy: completion.accuracy ?? "",
    completionCapturedAt: completion.capturedAt ?? "",
    outcome: completion.outcome ?? "Visit completed",
    notes: completion.notes ?? "",
    idempotencyKey: completion.idempotencyKey ?? operationId("visit_submit"),
  };
}

function migratePersistedVisits(rawQueue: QueueItem[], rawActiveVisit: unknown) {
  let activeVisit = normalizeActiveVisit(rawActiveVisit);
  const pendingCheckIns = new Map<string, JsonOperation>();

  for (const item of rawQueue) {
    const operation = item.operation;
    if (item.state === "confirmed" || operation?.type !== "json" || operation.path !== "/visits/check-in") continue;
    const visitId = typeof operation.body.visitId === "string" ? operation.body.visitId : "";
    if (visitId) pendingCheckIns.set(visitId, operation);
  }

  if (activeVisit && !activeVisit.checkIn) {
    const pendingCheckIn = pendingCheckIns.get(activeVisit.id);
    if (pendingCheckIn) activeVisit = { ...activeVisit, checkIn: submissionFieldsFromLegacy(activeVisit.id, pendingCheckIn.body, {}) };
  }

  const queue = rawQueue.flatMap((item): QueueItem[] => {
    const operation = item.operation;
    if (item.state !== "confirmed" && operation?.type === "json" && operation.path === "/visits/check-in") {
      return [];
    }
    if (item.state !== "confirmed" && operation?.type === "visit_complete") {
      const visitId = visitIdFromCompletionPath(operation.path);
      if (!visitId) return [];
      return [{
        ...item,
        label: item.label.replace(/ completion$/i, " · complete visit"),
        operation: {
          ...operation,
          type: "visit_submit",
          path: "/visits/submit",
          fields: submissionFieldsFromLegacy(visitId, pendingCheckIns.get(visitId)?.body, operation.fields),
        },
      }];
    }
    return [item];
  });

  return { queue, activeVisit };
}

function parseState(saved: string): PersistedState | null {
  try {
    const value = JSON.parse(saved) as Partial<PersistedState>;
    if (!value || !Array.isArray(value.outlets) || !Array.isArray(value.queue)) return null;
    const persisted = migratePersistedVisits(
      value.queue.filter((item) => item?.state === "confirmed" || Boolean(item?.operation)),
      value.activeVisit,
    );
    return {
      session: value.session ?? null,
      workState: value.workState ?? "not_started",
      outlets: value.outlets.map((outlet) => ({
        ...outlet,
        kind: outlet.kind === "self" ? "self" : "assigned",
        workDate: outlet.workDate || pakistanWorkDate(),
      })),
      queue: persisted.queue,
      activeVisit: persisted.activeVisit,
      territoryPolicy: normalizeTerritoryPolicy(value.territoryPolicy),
    };
  } catch {
    return null;
  }
}

function positionForPoint(policy: TerritoryPolicy, latitude: number, longitude: number): TerritoryPosition {
  if (policy.mode === "unrestricted") return "unrestricted";
  const boundaries = policy.territories.flatMap((territory) => territory.boundary ? [territory.boundary] : []);
  if (boundaries.length === 0) return "boundary_missing";
  return pointInAnyTerritory({ latitude, longitude }, boundaries) ? "inside" : "outside";
}

function territoryCopy(policy: TerritoryPolicy, position: TerritoryPosition) {
  const names = policy.territories.map((territory) => territory.name).join(" or ");
  if (position === "unrestricted") {
    return "No territory is assigned. Visits and orders are available wherever today’s work is active.";
  }
  if (position === "checking") return "Checking your current GPS position against assigned territory boundaries.";
  if (position === "inside") return `Inside ${names || "an assigned territory"}. Visits and orders are available.`;
  if (position === "boundary_missing") {
    return "An assigned territory has no usable map boundary. Ask a manager to draw and save it.";
  }
  return `Outside ${names || "your assigned territory"}. Visits and orders are disabled at this location.`;
}

async function jsonRequest(path: string, options: RequestInit = {}, token?: string) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The FieldOPS server could not complete this request.");
  return body;
}

async function preserveEvidence(uri: string, extension: string) {
  const directory = new Directory(Paths.document, "visit-evidence");
  directory.create({ intermediates: true, idempotent: true });
  const target = new File(directory, `${operationId("evidence")}.${extension}`);
  await new File(uri).copy(target);
  return target.uri;
}

export default function FieldOpsRoot() {
  return <SafeAreaProvider><FieldOpsApp /></SafeAreaProvider>;
}

function FieldOpsApp() {
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("today");
  const [workState, setWorkState] = useState<WorkState>("not_started");
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeVisit, setActiveVisit] = useState<ActiveVisit | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const audioRecorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: "document" });
  const [recording, setRecording] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState>(emptyPermissions);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [locationPending, setLocationPending] = useState(0);
  const [territoryPolicy, setTerritoryPolicy] = useState<TerritoryPolicy>(unrestrictedTerritoryPolicy);
  const [territoryPosition, setTerritoryPosition] = useState<TerritoryPosition>("unrestricted");
  const queueRef = useRef<QueueItem[]>([]);
  const syncingRef = useRef(false);
  const visitSubmittingRef = useRef(false);
  const permissionPrompted = useRef(false);
  const heartbeatRunningRef = useRef(false);
  const lastHeartbeatAtRef = useRef(0);

  const selected = outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];
  const assignedOutlets = outlets.filter((outlet) => outlet.kind === "assigned");
  const selfVisits = outlets.filter((outlet) => outlet.kind === "self");
  const completed = assignedOutlets.filter((outlet) => outlet.status === "completed").length;
  const pending = queue.filter((item) => item.state === "failed" || item.state === "pending" || item.state === "syncing").length + locationPending;
  const nextOutlet = useMemo(
    () => outlets.find((outlet) => outlet.kind === "assigned" && outlet.status !== "completed"),
    [outlets],
  );
  const permissionReady = permissionState.foreground && permissionState.services;
  const trackingReady = permissionState.foreground && permissionState.services;
  const workActuallyRunning = workState === "active" && trackingReady;
  const fieldActionsAllowed = territoryPosition === "unrestricted" || territoryPosition === "inside";
  const territoryMessage = territoryCopy(territoryPolicy, territoryPosition);

  function setQueueNow(update: (items: QueueItem[]) => QueueItem[]) {
    const next = update(queueRef.current).slice(-120);
    queueRef.current = next;
    setQueue(next);
  }

  function updateTerritoryPosition(latitude: number, longitude: number, policy = territoryPolicy) {
    const position = positionForPoint(policy, latitude, longitude);
    setTerritoryPosition(position);
    return position;
  }

  function requireTerritory(latitude: number, longitude: number) {
    const position = updateTerritoryPosition(latitude, longitude);
    if (position !== "inside" && position !== "unrestricted") {
      throw new Error(territoryCopy(territoryPolicy, position));
    }
  }

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (!saved) return;
      const value = parseState(saved);
      if (!value) return;
      setSession(value.session);
      setWorkState(value.workState);
      setOutlets(value.outlets);
      setQueue(value.queue);
      queueRef.current = value.queue;
      setActiveVisit(value.activeVisit);
      setTerritoryPolicy(value.territoryPolicy);
      setTerritoryPosition(value.territoryPolicy.mode === "restricted" ? "checking" : "unrestricted");
      if (value.activeVisit) setSelectedId(value.activeVisit.outletId);
      else if (value.outlets[0]) setSelectedId(value.outlets[0].id);
    }).finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      session,
      workState,
      outlets,
      queue,
      activeVisit,
      territoryPolicy,
    })).catch(() => undefined);
  }, [activeVisit, hydrated, outlets, queue, session, territoryPolicy, workState]);

  useEffect(() => {
    if (!hydrated || !session) return;
    refreshPermissions(false).then(() => {
      if (!permissionPrompted.current) {
        permissionPrompted.current = true;
        return requestLocationPermission();
      }
    }).catch(() => undefined);
  }, [hydrated, session?.token]);

  useEffect(() => {
    if (!hydrated || !session) return;
    refreshContext(false).catch(() => undefined);
    syncOperations().catch(() => undefined);
    refreshLocationCount().catch(() => undefined);
  }, [hydrated, session?.token]);

  useEffect(() => {
    if (!session || workState !== "active") return;
    if (!trackingReady) return;
    captureLiveHeartbeat(true).catch(() => undefined);
    const heartbeatTimer = setInterval(() => captureLiveHeartbeat(true).catch(() => undefined), 60_000);
    return () => clearInterval(heartbeatTimer);
  }, [session?.token, trackingReady, workState]);

  useEffect(() => {
    if (!hydrated || !session) return;
    const timer = setInterval(() => {
      refreshPermissions(false).catch(() => undefined);
      syncOperations().catch(() => undefined);
      flushLocationQueue(session.token).then(() => refreshLocationCount()).catch(() => undefined);
    }, 15_000);
    const appSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshPermissions(false)
          .then((permissions) => captureLiveHeartbeat(true, permissions))
          .catch(() => undefined);
        refreshContext(false).catch(() => undefined);
      }
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      if (state.isConnected) {
        syncOperations().catch(() => undefined);
        refreshPermissions(false)
          .then((permissions) => captureLiveHeartbeat(true, permissions))
          .catch(() => undefined);
        flushLocationQueue(session.token).then(() => refreshLocationCount()).catch(() => undefined);
        refreshContext(false).catch(() => undefined);
      }
    });
    return () => {
      clearInterval(timer);
      appSubscription.remove();
      networkSubscription();
    };
  }, [hydrated, session?.token, trackingReady, workState]);

  async function refreshLocationCount() {
    setLocationPending(await locationQueueCount());
  }

  async function refreshPermissions(markChecked = true) {
    const [foreground, camera, microphone, services] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      ImagePicker.getCameraPermissionsAsync(),
      getRecordingPermissionsAsync(),
      Location.hasServicesEnabledAsync(),
    ]);
    const next = {
      foreground: foreground.granted,
      camera: camera.granted,
      microphone: microphone.granted,
      services,
    };
    setPermissionState(next);
    if (markChecked) setPermissionChecked(true);
    return next;
  }

  async function requestLocationPermission() {
    setPermissionBusy(true);
    try {
      await Location.requestForegroundPermissionsAsync();
      await refreshPermissions();
    } finally {
      setPermissionBusy(false);
      setPermissionChecked(true);
    }
  }

  async function executeOperation(operation: OfflineOperation) {
    if (!session) throw new Error("Sign in again before syncing.");
    if (operation.type === "json") {
      return jsonRequest(operation.path, { method: "POST", body: JSON.stringify(operation.body) }, session.token);
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(operation.fields)) form.append(key, value);
    form.append("photo", operation.photo as never);
    form.append("audio", operation.audio as never);
    const response = await fetch(`${API_BASE}${operation.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Visit evidence could not be uploaded.");
    return body;
  }

  async function syncOperations() {
    if (!session || syncingRef.current) return;
    syncingRef.current = true;
    try {
      const candidates = [...queueRef.current]
        .filter((item) => item.operation && item.state !== "confirmed")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const item of candidates) {
        setQueueNow((items) => items.map((entry) => entry.id === item.id ? { ...entry, state: "syncing" } : entry));
        try {
          await executeOperation(item.operation!);
          setQueueNow((items) => items.map((entry) => entry.id === item.id
            ? { ...entry, state: "confirmed", operation: undefined, error: undefined }
            : entry));
        } catch (error) {
          setQueueNow((items) => items.map((entry) => entry.id === item.id ? {
            ...entry,
            state: "failed",
            attempts: entry.attempts + 1,
            error: error instanceof Error ? error.message : "Will retry when connected.",
          } : entry));
          break;
        }
      }
    } finally {
      syncingRef.current = false;
    }
  }

  function enqueue(label: string, operation: OfflineOperation) {
    const item: QueueItem = {
      id: operationId("event"),
      label,
      state: "pending",
      createdAt: new Date().toISOString(),
      attempts: 0,
      operation,
    };
    setQueueNow((items) => [...items, item]);
    setTimeout(() => syncOperations().catch(() => undefined), 0);
  }

  async function refreshContext(showMessage = true) {
    if (!session) return;
    setRefreshing(true);
    try {
      const context = await jsonRequest("/context", {}, session.token);
      const today = String(context.date ?? pakistanWorkDate());
      const localSelfVisits = outlets.filter((item) => item.kind === "self" && item.workDate === today);
      const localAssigned = new Map(outlets.filter((item) => item.kind === "assigned").map((item) => [item.routeId, item]));
      const assigned = (context.route as Outlet[]).map((item) => {
        const local = localAssigned.get(item.routeId);
        const localStatus = local?.status === "active" || local?.status === "completed" ? local.status : item.status;
        return { ...item, status: localStatus, kind: "assigned" as const, workDate: today };
      });
      const merged = [...assigned, ...localSelfVisits];
      const nextPolicy = normalizeTerritoryPolicy(context.territoryPolicy);
      setOutlets(merged);
      setTerritoryPolicy(nextPolicy);
      setTerritoryPosition(nextPolicy.mode === "restricted" ? "checking" : "unrestricted");
      const hasPendingAttendance = queueRef.current.some((item) => (
        item.operation?.type === "json"
        && item.operation.path === "/attendance"
        && item.state !== "confirmed"
      ));
      if (!hasPendingAttendance) setWorkState(context.workState ?? (context.shiftActive ? "active" : "not_started"));
      setSelectedId((current) => merged.some((item) => item.id === current) ? current : (merged[0]?.id ?? ""));

      const foreground = await Location.getForegroundPermissionsAsync();
      if (foreground.granted && await Location.hasServicesEnabledAsync()) {
        const point = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        updateTerritoryPosition(point.coords.latitude, point.coords.longitude, nextPolicy);
      }
      if (showMessage) Alert.alert("Visits refreshed", `${context.route.length} assigned visits downloaded.`);
    } catch (error) {
      if (showMessage) Alert.alert("Working offline", error instanceof Error ? error.message : "Could not refresh assigned visits.");
    } finally {
      setRefreshing(false);
    }
  }

  async function signIn(email: string, password: string) {
    const result = await jsonRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setSession(result);
    permissionPrompted.current = false;
    setScreen("today");
  }

  async function gps(accuracy = Location.Accuracy.High) {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) throw new Error("Location permission is off. Open Settings and allow location access.");
    if (!await Location.hasServicesEnabledAsync()) throw new Error("GPS is off. Turn on Location Services to continue.");
    const point = await Location.getCurrentPositionAsync({ accuracy });
    updateTerritoryPosition(point.coords.latitude, point.coords.longitude);
    return point;
  }

  async function captureLiveHeartbeat(force = false, permissions: PermissionState = permissionState) {
    if (!session || workState !== "active") return;
    if (!permissions.foreground || !permissions.services) return;
    if (heartbeatRunningRef.current) return;
    if (!force && Date.now() - lastHeartbeatAtRef.current < 45_000) {
      await flushLocationQueue(session.token);
      await refreshLocationCount();
      return;
    }

    heartbeatRunningRef.current = true;
    try {
      const point = await gps(Location.Accuracy.High);
      await queueLocationObjects([point], "foreground");
      lastHeartbeatAtRef.current = Date.now();
      await flushLocationQueue(session.token);
      await refreshLocationCount();
    } finally {
      heartbeatRunningRef.current = false;
    }
  }

  async function startWork() {
    if (!session) return;
    let permissions = await refreshPermissions();
    if (!permissions.foreground || !permissions.services) {
      Alert.alert("Location access required", "Turn on GPS and allow location while using FieldOPS before starting work.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open settings", onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    try {
      const point = await gps(Location.Accuracy.High);
      const capturedAt = new Date(point.timestamp).toISOString();
      setWorkState("active");
      await queueLocationObjects([point], "foreground");
      await flushLocationQueue(session.token);
      enqueue("Start work", { type: "json", path: "/attendance", body: {
        action: "check_in",
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("start"),
      } });
      await refreshLocationCount();
    } catch (error) {
      setWorkState("not_started");
      Alert.alert("Work did not start", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function finishWork() {
    if (!session) return;
    if (activeVisit) {
      Alert.alert("Finish the current visit", "Submit the current visit with its photo and audio note before finishing today’s work.");
      return;
    }
    try {
      const point = await gps(Location.Accuracy.High);
      const capturedAt = new Date(point.timestamp).toISOString();
      await queueLocationObjects([point], "foreground");
      enqueue("Finish today’s work", { type: "json", path: "/attendance", body: {
        action: "check_out",
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("finish"),
      } });
      setWorkState("finished");
      await flushLocationQueue(session.token);
      await refreshLocationCount();
    } catch (error) {
      Alert.alert("GPS required to finish", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function startVisit(outlet: Outlet) {
    if (!session) return;
    if (activeVisit) {
      Alert.alert("Finish the current visit", "Only one visit can be in progress at a time.");
      return;
    }
    if (!workActuallyRunning) {
      Alert.alert("Work is stopped", trackingReady ? "Tap Start work before beginning a visit." : "Turn on GPS and allow location first.");
      return;
    }
    try {
      const point = await gps();
      requireTerritory(point.coords.latitude, point.coords.longitude);
      const distance = Math.round(distanceMeters(
        { latitude: outlet.latitude, longitude: outlet.longitude },
        { latitude: point.coords.latitude, longitude: point.coords.longitude },
      ));
      if (distance > GEOFENCE_METERS) {
        Alert.alert("Move closer to the visit", `You are ${distance} m away. Visit check-in is allowed within ${GEOFENCE_METERS} m.`);
        return;
      }
      const visitId = operationId("visit");
      setActiveVisit({
        id: visitId,
        outletId: outlet.id,
        checkIn: {
          visitId,
          visitType: "assigned",
          outletId: outlet.id,
          routeId: outlet.routeId,
          checkInLatitude: String(point.coords.latitude),
          checkInLongitude: String(point.coords.longitude),
          checkInAccuracy: String(point.coords.accuracy ?? 0),
          checkInCapturedAt: new Date(point.timestamp).toISOString(),
        },
        outcome: "Order placed",
        notes: "",
      });
      setSelectedId(outlet.id);
      setOutlets((items) => items.map((item) => item.id === outlet.id ? { ...item, status: "active" } : item));
      setScreen("visit");
    } catch (error) {
      Alert.alert("Visit did not start", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function startUnplannedVisit(customerName: string, customerAddress: string) {
    if (!session) return;
    if (activeVisit) {
      Alert.alert("Finish the current visit", "Only one visit can be in progress at a time.");
      return;
    }
    if (!workActuallyRunning) {
      Alert.alert("Work is stopped", trackingReady ? "Tap Start work before beginning a visit." : "Turn on GPS and allow location first.");
      return;
    }
    try {
      const point = await gps();
      requireTerritory(point.coords.latitude, point.coords.longitude);
      const visitId = operationId("visit");
      const visit: Outlet = {
        routeId: "",
        id: visitId,
        code: "SELF",
        name: customerName,
        address: customerAddress || "Location captured by GPS",
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        sequence: selfVisits.length + 1,
        status: "active",
        notes: "",
        kind: "self",
        workDate: pakistanWorkDate(new Date(point.timestamp)),
      };
      setOutlets((items) => [...items, visit]);
      setActiveVisit({
        id: visitId,
        outletId: visitId,
        checkIn: {
          visitId,
          visitType: "self_initiated",
          customerName,
          customerAddress,
          checkInLatitude: String(point.coords.latitude),
          checkInLongitude: String(point.coords.longitude),
          checkInAccuracy: String(point.coords.accuracy ?? 0),
          checkInCapturedAt: new Date(point.timestamp).toISOString(),
        },
        outcome: "Order placed",
        notes: "",
      });
      setSelectedId(visitId);
      setScreen("visit");
    } catch (error) {
      Alert.alert("Visit did not start", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function takePhoto() {
    let permission = await ImagePicker.getCameraPermissionsAsync();
    if (!permission.granted) permission = await ImagePicker.requestCameraPermissionsAsync();
    await refreshPermissions(false);
    if (!permission.granted) {
      Alert.alert("Camera permission required", "Allow camera access to attach the required visit evidence.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open settings", onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.72 });
    if (!result.canceled) {
      const asset = result.assets[0];
      const uri = await preserveEvidence(asset.uri, "jpg");
      setActiveVisit((current) => current ? { ...current, photo: {
        uri,
        name: asset.fileName ?? `visit-${current.id}.jpg`,
        type: asset.mimeType ?? "image/jpeg",
      } } : current);
    }
  }

  async function toggleRecording() {
    if (recording) {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      setRecording(false);
      if (uri) {
        const preservedUri = await preserveEvidence(uri, "m4a");
        setActiveVisit((current) => current ? { ...current, audio: {
          uri: preservedUri,
          name: `visit-${current.id}.m4a`,
          type: "audio/m4a",
        } } : current);
      }
      return;
    }
    let permission = await getRecordingPermissionsAsync();
    if (!permission.granted) permission = await requestRecordingPermissionsAsync();
    await refreshPermissions(false);
    if (!permission.granted) {
      Alert.alert("Microphone permission required", "Allow microphone access to record the required visit note.", [
        { text: "Cancel", style: "cancel" },
        { text: "Open settings", onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
    setRecording(true);
  }

  async function finishVisit() {
    if (visitSubmittingRef.current) return;
    if (!session || !selected || !activeVisit || activeVisit.outletId !== selected.id) {
      Alert.alert("Start the visit first", "Check in with GPS before completing the visit.");
      return;
    }
    if (recording) {
      Alert.alert("Stop the recording first", "Stop and save the audio note before submitting the visit.");
      return;
    }
    if (!hasRequiredVisitEvidence(activeVisit)) {
      Alert.alert("Photo and audio required", "Take one visit photo and record an audio note before finishing.");
      return;
    }
    visitSubmittingRef.current = true;
    try {
      const point = await gps();
      requireTerritory(point.coords.latitude, point.coords.longitude);
      const distance = Math.round(distanceMeters(
        { latitude: selected.latitude, longitude: selected.longitude },
        { latitude: point.coords.latitude, longitude: point.coords.longitude },
      ));
      if (distance > GEOFENCE_METERS) {
        Alert.alert("Return to the visit location", `You are ${distance} m away. Finish the visit within ${GEOFENCE_METERS} m.`);
        return;
      }
      enqueue(`${selected.name} · complete visit`, {
        type: "visit_submit",
        path: "/visits/submit",
        fields: {
          ...activeVisit.checkIn,
          visitId: activeVisit.id,
          outcome: activeVisit.outcome,
          notes: activeVisit.notes,
          completionLatitude: String(point.coords.latitude),
          completionLongitude: String(point.coords.longitude),
          completionAccuracy: String(point.coords.accuracy ?? 0),
          completionCapturedAt: new Date(point.timestamp).toISOString(),
          idempotencyKey: operationId("visit_submit"),
        },
        photo: activeVisit.photo,
        audio: activeVisit.audio,
      });
      setOutlets((items) => items.map((item) => item.id === selected.id ? { ...item, status: "completed" } : item));
      setActiveVisit(null);
      setScreen("route");
      Alert.alert("Visit submitted", "The complete visit, photo, audio note, and GPS were submitted together. If offline, this user-submitted record will retry safely.");
    } catch (error) {
      Alert.alert("Visit not finished", error instanceof Error ? error.message : "Turn on GPS and try again.");
    } finally {
      visitSubmittingRef.current = false;
    }
  }

  async function createOrder(order: OrderDraft) {
    if (!session) return;
    try {
      const point = await gps(Location.Accuracy.Balanced);
      requireTerritory(point.coords.latitude, point.coords.longitude);
      const capturedAt = new Date(point.timestamp).toISOString();
      enqueue(`Order · ${order.customerName}`, { type: "json", path: "/orders", body: {
        ...order,
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("order"),
      } });
      Alert.alert("Order saved", "The location is saved and this order will sync automatically.");
      setScreen("today");
    } catch (error) {
      Alert.alert("Order not saved", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  function moveOutlet(id: string, direction: -1 | 1) {
    setOutlets((items) => {
      const index = items.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= items.length) return items;
      const copy = [...items];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy.map((item, position) => ({ ...item, sequence: position + 1 }));
    });
  }

  async function retryEverything() {
    await syncOperations();
    if (session) await flushLocationQueue(session.token);
    await refreshLocationCount();
    await refreshContext(false);
  }

  async function signOut() {
    setSession(null);
    setOutlets([]);
    setQueueNow(() => []);
    setWorkState("not_started");
    setActiveVisit(null);
    setTerritoryPolicy(unrestrictedTerritoryPolicy);
    setTerritoryPosition("unrestricted");
    setScreen("today");
  }

  if (!hydrated) {
    return <SafeAreaView className="flex-1 bg-paper" edges={["top", "bottom"]}>
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-2xl font-black text-ink">Loading FieldOPS…</Text>
      </View>
    </SafeAreaView>;
  }
  if (!session) return <Login onSubmit={signIn} />;
  if (!permissionChecked || !permissionReady) {
    return <PermissionGate
      state={permissionState}
      busy={permissionBusy}
      onRequest={requestLocationPermission}
      onSettings={() => Linking.openSettings()}
      onLogout={signOut}
    />;
  }

  return <SafeAreaView className="flex-1 bg-paper" edges={["top", "bottom"]}>
    <View className="flex-1">
      <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
        <View className="gap-4 px-5 py-5">
          <Header
            pending={pending}
            refreshing={refreshing}
            onSync={() => setScreen("sync")}
            onRefresh={() => refreshContext()}
          />
          <TerritoryBanner
            policy={territoryPolicy}
            position={territoryPosition}
            message={territoryMessage}
            onRefresh={() => refreshContext(false)}
          />
          {screen === "today" && <Today
            workState={workState}
            trackingReady={trackingReady}
            completed={completed}
            total={assignedOutlets.length}
            selfVisitCount={selfVisits.length}
            nextOutlet={nextOutlet}
            fieldActionsAllowed={fieldActionsAllowed}
            territoryMessage={territoryMessage}
            onStartWork={startWork}
            onFinishWork={finishWork}
            onFixGps={() => Linking.openSettings()}
            onStartVisit={() => nextOutlet && startVisit(nextOutlet)}
            onNewVisit={() => setScreen("new_visit")}
            onRoute={() => setScreen("route")}
            onOrder={() => setScreen("order")}
          />}
          {screen === "route" && <Route
            assigned={assignedOutlets}
            selfVisits={selfVisits}
            territoryPolicy={territoryPolicy}
            canAddVisit={workActuallyRunning && fieldActionsAllowed}
            onNewVisit={() => setScreen("new_visit")}
            onSelect={(id) => {
              setSelectedId(id);
              setScreen("visit");
            }}
            onMove={moveOutlet}
          />}
          {screen === "new_visit" && <NewVisit
            running={workActuallyRunning}
            accessAllowed={fieldActionsAllowed}
            territoryMessage={territoryMessage}
            onSubmit={startUnplannedVisit}
            onBack={() => setScreen("route")}
          />}
          {screen === "visit" && selected && <Visit
            outlet={selected}
            activeVisit={activeVisit?.outletId === selected.id}
            accessAllowed={fieldActionsAllowed}
            territoryMessage={territoryMessage}
            outcome={activeVisit?.outcome ?? "Order placed"}
            setOutcome={(value) => setActiveVisit((current) => current ? { ...current, outcome: value } : current)}
            notes={activeVisit?.notes ?? ""}
            setNotes={(value) => setActiveVisit((current) => current ? { ...current, notes: value } : current)}
            photo={activeVisit?.photo}
            audio={activeVisit?.audio}
            recording={Boolean(recording)}
            onStart={() => startVisit(selected)}
            onPhoto={takePhoto}
            onAudio={toggleRecording}
            onFinish={finishVisit}
          />}
          {screen === "order" && <Order
            outlets={assignedOutlets}
            accessAllowed={fieldActionsAllowed}
            territoryMessage={territoryMessage}
            onSubmit={createOrder}
          />}
          {screen === "sync" && <SyncQueue
            queue={queue}
            locationPending={locationPending}
            onRetry={retryEverything}
          />}
          {screen === "profile" && <Profile
            session={session}
            workState={workState}
            trackingReady={trackingReady}
            pending={pending}
            territoryMessage={territoryMessage}
            onLogout={signOut}
          />}
        </View>
      </ScrollView>
      <Nav screen={screen} setScreen={setScreen} />
    </View>
  </SafeAreaView>;
}

function Login({ onSubmit }: { onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return <SafeAreaView className="flex-1 bg-ink" edges={["top", "bottom"]}>
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
      <View className="min-h-screen justify-center gap-7 px-6 py-10">
        <View className="items-center">
          <View className="h-[62px] w-[62px] items-center justify-center rounded-[18px] bg-gold">
            <Text className="text-2xl font-black text-ink">FO</Text>
          </View>
          <Text className="mt-4 text-center text-[29px] font-black text-white">Yousuf Rice FieldOPS</Text>
          <Text className="mt-2 max-w-[360px] text-center leading-5 text-[#BAC4D8]">
            Assigned visits, territory-aware field work, evidence, orders, and offline route tracking.
          </Text>
        </View>
        <View className="gap-3.5 rounded-[18px] bg-white p-5">
          <Eyebrow>SALESPERSON SIGN IN</Eyebrow>
          <TextInput
            accessibilityLabel="Work email"
            className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            placeholder="Your work email"
            placeholderTextColor="#697184"
          />
          <TextInput
            accessibilityLabel="Password"
            className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            placeholder="Your separate password"
            placeholderTextColor="#697184"
          />
          <Button
            label={busy ? "Signing in…" : "Sign in"}
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              try {
                await onSubmit(email.trim(), password);
              } catch (error) {
                Alert.alert("Sign in failed", error instanceof Error ? error.message : "Try again.");
              } finally {
                setBusy(false);
              }
            }}
          />
        </View>
      </View>
    </ScrollView>
  </SafeAreaView>;
}

function PermissionGate({
  state,
  busy,
  onRequest,
  onSettings,
  onLogout,
}: {
  state: PermissionState;
  busy: boolean;
  onRequest: () => void;
  onSettings: () => void;
  onLogout: () => void;
}) {
  return <SafeAreaView className="flex-1 bg-paper" edges={["top", "bottom"]}>
    <ScrollView className="flex-1">
      <View className="min-h-screen justify-center gap-4 px-6 py-10">
        <Eyebrow>FIRST STEP</Eyebrow>
        <ScreenTitle>Allow location</ScreenTitle>
        <BodyText>
          FieldOPS needs current location for visit boundaries, work-route updates and GPS evidence. Camera and microphone are requested only when used.
        </BodyText>
        <View className="rounded-2xl border border-line bg-white px-4">
          <PermissionRow label="Location while using the app" ready={state.foreground} />
          <PermissionRow label="GPS / Location Services" ready={state.services} />
          <PermissionRow label="Camera evidence" ready={state.camera} later />
          <PermissionRow label="Audio evidence" ready={state.microphone} later />
        </View>
        <Button label={busy ? "Checking location…" : "Allow location"} disabled={busy} onPress={onRequest} />
        <GhostButton dark label="Open phone settings" onPress={onSettings} />
        <GhostButton dark label="Sign out" onPress={onLogout} />
      </View>
    </ScrollView>
  </SafeAreaView>;
}

function PermissionRow({ label, ready, later = false }: { label: string; ready: boolean; later?: boolean }) {
  return <View className="min-h-14 flex-row items-center gap-2.5 border-b border-line py-3.5 last:border-b-0">
    <View className={classes("h-2.5 w-2.5 rounded-full", ready ? "bg-success" : later ? "bg-gold" : "bg-danger")} />
    <Text className="flex-1 font-extrabold text-ink">{label}</Text>
    <Text className={classes("text-[11px] font-black", ready ? "text-success" : later ? "text-[#805C00]" : "text-danger")}>
      {ready ? "Allowed" : later ? "When needed" : "Required"}
    </Text>
  </View>;
}

function Header({
  pending,
  refreshing,
  onSync,
  onRefresh,
}: {
  pending: number;
  refreshing: boolean;
  onSync: () => void;
  onRefresh: () => void;
}) {
  return <View className="flex-row items-start justify-between gap-2.5">
    <View className="flex-1">
      <Eyebrow>YOUSUF RICE · FIELDOPS</Eyebrow>
      <Text className="mt-1 text-[26px] font-extrabold text-ink">Today’s field work</Text>
    </View>
    <View className="flex-row gap-1.5">
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Refresh today’s assignments and territory"
        className="min-h-12 min-w-12 items-center justify-center rounded-full bg-[#E6ECF8] px-3"
        onPress={onRefresh}
      >
        <Text className="text-[11px] font-black text-field">{refreshing ? "Loading" : "Refresh"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open activity. ${pending} records pending`}
        className="min-h-12 min-w-12 items-center justify-center rounded-full bg-[#FFF1D0] px-3"
        onPress={onSync}
      >
        <Text className="text-[11px] font-black text-[#805C00]">{pending} pending</Text>
      </TouchableOpacity>
    </View>
  </View>;
}

function TerritoryBanner({
  policy,
  position,
  message,
  onRefresh,
}: {
  policy: TerritoryPolicy;
  position: TerritoryPosition;
  message: string;
  onRefresh: () => void;
}) {
  const allowed = position === "inside" || position === "unrestricted";
  return <View
    accessibilityRole="summary"
    className={classes(
      "rounded-xl border-l-4 p-4",
      allowed ? "border-success bg-[#E9F5EF]" : position === "checking" ? "border-gold bg-[#FFF1D0]" : "border-danger bg-[#FCEDEA]",
    )}
  >
    <View className="flex-row items-start justify-between gap-3">
      <View className="flex-1">
        <Text className={classes("text-[10px] font-black tracking-wider", allowed ? "text-success" : "text-danger")}>
          {policy.mode === "unrestricted" ? "NO TERRITORY RESTRICTION" : `${policy.assignedCount} TERRITOR${policy.assignedCount === 1 ? "Y" : "IES"} ASSIGNED`}
        </Text>
        <Text className="mt-1 text-lg font-black text-ink">
          {position === "inside" ? "Inside territory" : position === "unrestricted" ? "Field access open" : position === "checking" ? "Checking field access" : "Field actions blocked"}
        </Text>
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Check territory access again"
        className="min-h-12 justify-center rounded-lg border border-ink px-3"
        onPress={onRefresh}
      >
        <Text className="font-extrabold text-ink">Check GPS</Text>
      </TouchableOpacity>
    </View>
    <Text className="mt-2 leading-5 text-[#586273]">{message}</Text>
  </View>;
}

function Today({
  workState,
  trackingReady,
  completed,
  total,
  selfVisitCount,
  nextOutlet,
  fieldActionsAllowed,
  territoryMessage,
  onStartWork,
  onFinishWork,
  onFixGps,
  onStartVisit,
  onNewVisit,
  onRoute,
  onOrder,
}: {
  workState: WorkState;
  trackingReady: boolean;
  completed: number;
  total: number;
  selfVisitCount: number;
  nextOutlet?: Outlet;
  fieldActionsAllowed: boolean;
  territoryMessage: string;
  onStartWork: () => void;
  onFinishWork: () => void;
  onFixGps: () => void;
  onStartVisit: () => void;
  onNewVisit: () => void;
  onRoute: () => void;
  onOrder: () => void;
}) {
  const running = workState === "active" && trackingReady;
  const title = workState === "finished"
    ? "Today’s work finished"
    : running
      ? "Work in progress"
      : workState === "active"
        ? "Work stopped"
        : "Ready to start";
  const detail = workState === "active" && !trackingReady
        ? "GPS or location access is off"
    : running
      ? "Route recording every minute"
      : workState === "finished"
        ? "Tracking ended for today"
        : "GPS starts with your work";
  const actionEnabled = running && fieldActionsAllowed;
  return <>
    <View className={classes(
      "flex-row items-center justify-between gap-3 rounded-2xl border-l-[5px] bg-ink p-[18px]",
      running ? "border-l-[#52B889]" : workState === "active" ? "border-l-[#D05242]" : "border-l-[#95A0B5]",
    )}>
      <View className="flex-1">
        <Text className="text-[10px] font-black text-[#AAB3C5]">TODAY · WORK STATUS</Text>
        <Text className="mt-1 text-lg font-black text-white">{title}</Text>
        <Text className="mt-1 text-[11px] text-[#BAC4D8]">{detail}</Text>
      </View>
      {workState === "not_started" && <Button label="Start work" onPress={onStartWork} />}
      {workState === "active" && trackingReady && <Button label="Finish today" onPress={onFinishWork} />}
      {workState === "active" && !trackingReady && <Button label="Fix GPS" onPress={onFixGps} />}
    </View>

    <SectionTitle>Assigned commitments</SectionTitle>
    <View className="flex-row justify-between border-y border-line py-4">
      <Stat value={`${completed}/${total}`} label="Completed" />
      <Stat value={`${Math.max(0, total - completed)}`} label="Still assigned" />
      <Stat value={running ? "Live" : "Stopped"} label="Route tracking" />
    </View>

    {nextOutlet ? <View className="rounded-2xl bg-field p-5">
      <Text className="text-[10px] font-black tracking-wider text-[#B6C2DF]">NEXT ASSIGNED VISIT · {GEOFENCE_METERS} M CHECK-IN</Text>
      <Text className="mt-2.5 text-2xl font-black text-white">{nextOutlet.name}</Text>
      <Text className="mt-1.5 text-[#C2CBE0]">{nextOutlet.address}</Text>
      <View className="mt-5 flex-row flex-wrap gap-2.5">
        <Button label="Start assigned visit" disabled={!actionEnabled} onPress={onStartVisit} />
        <GhostButton label="All assigned visits" onPress={onRoute} />
      </View>
      {!fieldActionsAllowed && <Text className="mt-3 leading-5 text-[#FFF1D0]">{territoryMessage}</Text>}
    </View> : <EmptyState title="No assigned visits waiting" body="You can still add your own customer visit while work, GPS, and territory access are active." />}

    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Add an unplanned customer visit"
      accessibilityState={{ disabled: !actionEnabled }}
      className={classes(
        "min-h-24 flex-row items-center justify-between rounded-[14px] border border-success bg-[#E4F2EA] p-[18px]",
        !actionEnabled && "opacity-45",
      )}
      disabled={!actionEnabled}
      onPress={onNewVisit}
    >
      <View className="flex-1">
        <Text className="text-[10px] font-black tracking-wider text-success">SALESPERSON-ADDED · {selfVisitCount} TODAY</Text>
        <Text className="mt-1 text-xl font-black text-ink">Visit another customer</Text>
        <Text className="mt-1 text-xs text-[#4F655C]">GPS, photo and audio are required</Text>
      </View>
      <Text className="font-black text-success">Add visit</Text>
    </TouchableOpacity>

    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Take a new order"
      accessibilityState={{ disabled: !fieldActionsAllowed }}
      className={classes(
        "min-h-20 flex-row items-center justify-between rounded-[14px] bg-gold p-[18px]",
        !fieldActionsAllowed && "opacity-45",
      )}
      disabled={!fieldActionsAllowed}
      onPress={onOrder}
    >
      <View>
        <Text className="text-[10px] font-black tracking-wider text-[#5F4600]">QUICK ORDER</Text>
        <Text className="mt-1 text-lg font-black text-ink">Take an order</Text>
      </View>
      <Text className="font-black text-ink">Open</Text>
    </TouchableOpacity>

    <InfoNotice
      title="Offline-safe route"
      body="Assigned completion remains separate from your own visits. GPS, evidence, orders, and status stay on this phone until the server confirms them."
    />
  </>;
}

function Route({
  assigned,
  selfVisits,
  territoryPolicy,
  canAddVisit,
  onSelect,
  onMove,
  onNewVisit,
}: {
  assigned: Outlet[];
  selfVisits: Outlet[];
  territoryPolicy: TerritoryPolicy;
  canAddVisit: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onNewVisit: () => void;
}) {
  return <>
    <ScreenTitle>Today’s visits</ScreenTitle>
    <BodyText>Management assignments stay separate from customer visits you add yourself.</BodyText>
    <Button label="Add unplanned customer visit" disabled={!canAddVisit} onPress={onNewVisit} />
    <SectionTitle>Assigned by management</SectionTitle>
    {assigned.length > 0 && <RouteMap outlets={assigned} territories={territoryPolicy.territories} />}
    {assigned.length === 0 && <EmptyState title="No assigned visits" body="You can still add your own visit above when field access is available." />}
    {assigned.map((outlet, index) => <View key={outlet.id} className="min-h-[68px] flex-row items-center gap-2.5 border-b border-line py-3">
      <Text className="w-7 font-black text-[#9A7A23]">{String(index + 1).padStart(2, "0")}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open ${outlet.name}`}
        className="min-h-12 flex-1 justify-center"
        onPress={() => onSelect(outlet.id)}
      >
        <Text className="font-extrabold text-ink">{outlet.name}</Text>
        <Text className="mt-1 text-xs text-muted">{outlet.address}</Text>
      </TouchableOpacity>
      <View className="gap-1">
        <CompactButton label="Earlier" disabled={index === 0} onPress={() => onMove(outlet.id, -1)} />
        <CompactButton label="Later" disabled={index === assigned.length - 1} onPress={() => onMove(outlet.id, 1)} />
      </View>
      <Status status={outlet.status} />
    </View>)}

    <SectionTitle>Added by you</SectionTitle>
    {selfVisits.length === 0
      ? <View className="rounded-[10px] border border-dashed border-line p-4"><BodyText>No unplanned visits recorded today.</BodyText></View>
      : selfVisits.map((outlet) => <TouchableOpacity
        key={outlet.id}
        accessibilityRole="button"
        accessibilityLabel={`Open your visit to ${outlet.name}`}
        className="mb-2 min-h-16 flex-row items-center gap-3 rounded-xl bg-[#F0F7F3] p-3.5"
        onPress={() => onSelect(outlet.id)}
      >
        <View className="h-8 w-8 items-center justify-center rounded-full bg-success"><Text className="text-xs font-black text-white">SELF</Text></View>
        <View className="flex-1">
          <Text className="font-extrabold text-ink">{outlet.name}</Text>
          <Text className="mt-1 text-xs text-muted">{outlet.address}</Text>
        </View>
        <Status status={outlet.status} />
      </TouchableOpacity>)}
  </>;
}

function NewVisit({
  running,
  accessAllowed,
  territoryMessage,
  onSubmit,
  onBack,
}: {
  running: boolean;
  accessAllowed: boolean;
  territoryMessage: string;
  onSubmit: (customerName: string, customerAddress: string) => Promise<void>;
  onBack: () => void;
}) {
  const [customerName, setCustomerName] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const enabled = running && accessAllowed;
  return <>
    <Eyebrow>SALESPERSON-ADDED VISIT</Eyebrow>
    <ScreenTitle>Visit another customer</ScreenTitle>
    <BodyText>
      Starting captures this GPS point. Finishing requires you to remain within {GEOFENCE_METERS} m and attach photo and audio evidence.
    </BodyText>
    {!enabled && <WarningNotice
      title={!running ? "Start work and GPS first" : "Visit unavailable here"}
      body={!running ? "Unplanned visits begin only while route tracking is active." : territoryMessage}
    />}
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <InputLabel>CUSTOMER OR SHOP NAME · REQUIRED</InputLabel>
      <TextInput
        accessibilityLabel="Customer or shop name"
        className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
        value={customerName}
        onChangeText={setCustomerName}
        placeholder="Example: Al Madina Store"
        placeholderTextColor="#697184"
        autoFocus
      />
      <InputLabel>ADDRESS OR AREA · OPTIONAL</InputLabel>
      <TextInput
        accessibilityLabel="Customer address or area"
        className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
        value={customerAddress}
        onChangeText={setCustomerAddress}
        placeholder="GPS saves the exact point"
        placeholderTextColor="#697184"
      />
      <Button
        label={busy ? "Capturing GPS…" : "Start visit at this location"}
        disabled={busy || !enabled}
        onPress={async () => {
          if (!customerName.trim()) {
            Alert.alert("Customer name required", "Enter the customer or shop name before starting the visit.");
            return;
          }
          setBusy(true);
          try {
            await onSubmit(customerName.trim(), customerAddress.trim());
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
    <GhostButton dark label="Back to visits" onPress={onBack} />
  </>;
}

function RouteMap({ outlets, territories }: { outlets: Outlet[]; territories: TerritoryInfo[] }) {
  const points = JSON.stringify(outlets.map((outlet) => ({
    name: outlet.name,
    address: outlet.address,
    lat: outlet.latitude,
    lng: outlet.longitude,
  }))).replaceAll("<", "\\u003c");
  const polygons = JSON.stringify(territories.flatMap((territory) => territory.boundary ? [{
    type: "Feature",
    properties: { name: territory.name },
    geometry: territory.boundary,
  }] : [])).replaceAll("<", "\\u003c");
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet"></head><body style="height:100%;margin:0"><div id="map" style="height:100%"></div><script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script><script>const points=${points};const polygons=${polygons};const map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[67.035,24.815],zoom:11.8});const bounds=new maplibregl.LngLatBounds();map.on('load',()=>{if(polygons.length){map.addSource('territories',{type:'geojson',data:{type:'FeatureCollection',features:polygons}});map.addLayer({id:'territory-fill',type:'fill',source:'territories',paint:{'fill-color':'#243D74','fill-opacity':0.14}});map.addLayer({id:'territory-line',type:'line',source:'territories',paint:{'line-color':'#243D74','line-width':3}});polygons.forEach(f=>f.geometry.coordinates[0].forEach(p=>bounds.extend(p)))}points.forEach((p,i)=>{new maplibregl.Marker({color:'#D8A629'}).setLngLat([p.lng,p.lat]).setPopup(new maplibregl.Popup().setText((i+1)+'. '+p.name+' · '+p.address)).addTo(map);bounds.extend([p.lng,p.lat])});if(!bounds.isEmpty())map.fitBounds(bounds,{padding:35,maxZoom:14,duration:0})});</script></body></html>`;
  return <View className="h-[265px] overflow-hidden rounded-[14px] border border-line">
    <WebView source={{ html }} originWhitelist={["*"]} javaScriptEnabled />
  </View>;
}

function Visit({
  outlet,
  activeVisit,
  accessAllowed,
  territoryMessage,
  outcome,
  setOutcome,
  notes,
  setNotes,
  photo,
  audio,
  recording,
  onStart,
  onPhoto,
  onAudio,
  onFinish,
}: {
  outlet: Outlet;
  activeVisit: boolean;
  accessAllowed: boolean;
  territoryMessage: string;
  outcome: string;
  setOutcome: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  photo?: EvidenceAttachment;
  audio?: EvidenceAttachment;
  recording: boolean;
  onStart: () => void;
  onPhoto: () => void;
  onAudio: () => void;
  onFinish: () => void;
}) {
  const outcomes = ["Order placed", "Order discussed", "No order", "Shop closed", "Owner unavailable"];
  const selfCreated = outlet.kind === "self";
  return <>
    <Eyebrow>{selfCreated ? "SALESPERSON-ADDED VISIT" : "MANAGEMENT-ASSIGNED VISIT"}</Eyebrow>
    <ScreenTitle>{outlet.name}</ScreenTitle>
    <BodyText>{outlet.address}</BodyText>
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <Eyebrow>VISIT STATUS</Eyebrow>
      <Text className="text-xl font-black text-ink">
        {activeVisit ? "Visit in progress" : outlet.status === "completed" ? "Visit completed" : `Ready for ${GEOFENCE_METERS} m check-in`}
      </Text>
      {!accessAllowed && <WarningNotice title="Visit unavailable here" body={territoryMessage} />}
      {!selfCreated && !activeVisit && outlet.status !== "completed" && <Button label="GPS check in" disabled={!accessAllowed} onPress={onStart} />}
    </View>
    {activeVisit && <>
      <WarningNotice
        title="Required before finishing"
        body={`This visit stays only on this phone until you submit it. Stay within ${GEOFENCE_METERS} m, remain inside an assigned territory if one applies, take one photo, and record one audio note.`}
      />
      <SectionTitle>Visit outcome</SectionTitle>
      <View className="flex-row flex-wrap gap-2">
        {outcomes.map((item) => <Choice
          key={item}
          label={item}
          selected={outcome === item}
          onPress={() => setOutcome(item)}
        />)}
      </View>
      <TextInput
        accessibilityLabel="Visit notes"
        className="min-h-[88px] rounded-[9px] border border-line bg-white px-3 py-3 text-base text-ink"
        value={notes}
        onChangeText={setNotes}
        placeholder="Visit notes"
        placeholderTextColor="#697184"
        multiline
        textAlignVertical="top"
      />
      <View className="flex-row gap-2.5">
        <EvidenceButton label={photo ? "Photo saved" : "Take required photo"} active={Boolean(photo)} onPress={onPhoto} />
        <EvidenceButton label={recording ? "Stop recording" : audio ? "Audio saved" : "Record required audio"} active={Boolean(audio || recording)} onPress={onAudio} />
      </View>
      {photo && <Image accessibilityLabel="Visit evidence preview" source={{ uri: photo.uri }} className="h-[220px] w-full rounded-xl" />}
      {audio && <Text className="rounded-lg bg-[#E9F5EF] p-3 font-extrabold text-[#205E49]">Audio note is saved on this phone</Text>}
      <Button label="Submit complete visit" disabled={!accessAllowed || !photo || !audio || recording} onPress={onFinish} />
    </>}
  </>;
}

type OrderDraft = {
  outletId: string;
  customerName: string;
  phone: string;
  address: string;
  productName: string;
  quantityKg: number;
  unitPrice: number;
  notes: string;
};

function Order({
  outlets,
  accessAllowed,
  territoryMessage,
  onSubmit,
}: {
  outlets: Outlet[];
  accessAllowed: boolean;
  territoryMessage: string;
  onSubmit: (order: OrderDraft) => Promise<void>;
}) {
  const [outletId, setOutletId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [quantity, setQuantity] = useState("5");
  const [unitPrice, setUnitPrice] = useState("450");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const total = Math.max(0, Number(quantity) || 0) * Math.max(0, Number(unitPrice) || 0);
  return <>
    <ScreenTitle>Take an order</ScreenTitle>
    <BodyText>The current GPS point is saved. If territories are assigned, orders are enabled only inside one of them.</BodyText>
    {!accessAllowed && <WarningNotice title="Orders unavailable here" body={territoryMessage} />}
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <InputLabel>ASSIGNED VISIT · OPTIONAL</InputLabel>
      <View className="flex-row flex-wrap gap-2">
        <Choice label="Any customer" selected={!outletId} onPress={() => setOutletId("")} />
        {outlets.map((outlet) => <Choice
          key={outlet.id}
          label={outlet.name}
          selected={outletId === outlet.id}
          onPress={() => {
            setOutletId(outlet.id);
            setCustomerName(outlet.name);
            setAddress(outlet.address);
          }}
        />)}
      </View>
      <InputLabel>CUSTOMER</InputLabel>
      <FieldInput label="Customer or shop name" value={customerName} onChangeText={setCustomerName} placeholder="Customer or shop name" />
      <FieldInput label="Customer phone" value={phone} onChangeText={setPhone} placeholder="Phone · optional" keyboardType="phone-pad" />
      <FieldInput label="Customer address" value={address} onChangeText={setAddress} placeholder="Address · optional" />
      <InputLabel>PRODUCT</InputLabel>
      <TextInput
        accessibilityLabel="Product"
        className="min-h-12 rounded-[9px] border border-line bg-[#F4F5F2] px-3 text-base text-ink"
        value="Yousuf Super Kernel Basmati"
        editable={false}
      />
      <FieldInput label="Quantity in kilograms" value={quantity} onChangeText={setQuantity} placeholder="Quantity kg" keyboardType="decimal-pad" />
      <FieldInput label="Unit price" value={unitPrice} onChangeText={setUnitPrice} placeholder="Price per kg" keyboardType="decimal-pad" />
      <TextInput
        accessibilityLabel="Order notes"
        className="min-h-[88px] rounded-[9px] border border-line bg-white px-3 py-3 text-base text-ink"
        value={notes}
        onChangeText={setNotes}
        placeholder="Order notes"
        placeholderTextColor="#697184"
        multiline
        textAlignVertical="top"
      />
      <View className="flex-row justify-between border-t border-line pt-3.5">
        <Text className="font-bold text-muted">Order total</Text>
        <Text className="text-lg font-black text-ink">PKR {total.toLocaleString()}</Text>
      </View>
      <Button
        label={busy ? "Saving order…" : "Save order"}
        disabled={busy || !accessAllowed}
        onPress={async () => {
          const quantityKg = Number(quantity);
          const price = Number(unitPrice);
          if (!customerName.trim() || !Number.isFinite(quantityKg) || quantityKg <= 0 || !Number.isFinite(price) || price < 0) {
            Alert.alert("Complete the order", "Customer, quantity, and price are required.");
            return;
          }
          setBusy(true);
          try {
            await onSubmit({
              outletId,
              customerName: customerName.trim(),
              phone: phone.trim(),
              address: address.trim(),
              productName: "Yousuf Super Kernel Basmati",
              quantityKg,
              unitPrice: price,
              notes: notes.trim(),
            });
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  </>;
}

function SyncQueue({ queue, locationPending, onRetry }: { queue: QueueItem[]; locationPending: number; onRetry: () => void }) {
  const pending = queue.filter((item) => item.state !== "confirmed").length + locationPending;
  return <>
    <ScreenTitle>Offline & server activity</ScreenTitle>
    <BodyText>In-progress visits stay on this phone. A visit enters this queue only after you submit it with both photo and audio; failed submitted work retries when internet returns.</BodyText>
    {pending > 0 && <Button label="Retry all now" onPress={onRetry} />}
    <View className="flex-row items-center gap-3 rounded-xl bg-[#E6ECF8] p-4">
      <Text className="text-[27px] font-black text-field">{locationPending}</Text>
      <View>
        <Text className="font-extrabold text-ink">Route points waiting</Text>
        <Text className="mt-1 text-xs text-muted">Minute-by-minute GPS saved on this phone</Text>
      </View>
    </View>
    {queue.length === 0
      ? <EmptyState title="No work activity yet" body="Start work to begin the activity record." />
      : [...queue].reverse().map((item) => <View key={item.id} className="min-h-16 flex-row items-center gap-2.5 border-b border-line py-3">
        <View className={classes(
          "h-2.5 w-2.5 rounded-full",
          item.state === "confirmed" ? "bg-success" : item.state === "pending" || item.state === "syncing" ? "bg-gold" : "bg-danger",
        )} />
        <View className="flex-1">
          <Text className="font-extrabold text-ink">{item.label}</Text>
          <Text className="mt-1 text-xs text-muted">
            {item.state === "confirmed"
              ? "Saved by server"
              : item.state === "syncing"
                ? "Uploading now"
                : item.error ?? "Saved on phone · waiting for internet"}
          </Text>
        </View>
      </View>)}
  </>;
}

function Profile({
  session,
  workState,
  trackingReady,
  pending,
  territoryMessage,
  onLogout,
}: {
  session: Session;
  workState: WorkState;
  trackingReady: boolean;
  pending: number;
  territoryMessage: string;
  onLogout: () => void;
}) {
  return <>
    <ScreenTitle>Field profile</ScreenTitle>
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <Eyebrow>SALES REPRESENTATIVE</Eyebrow>
      <Text className="text-xl font-black text-ink">{session.employee.name}</Text>
      <BodyText>Employee code {session.employee.code}</BodyText>
    </View>
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <Text className="text-xl font-black text-ink">Tracking & privacy</Text>
      <BodyText>
        While FieldOPS is open during active work, it records the work route about once per minute and uploads offline points when a connection returns.
      </BodyText>
      <ProfileLine>Today: {workState.replace("_", " ")}</ProfileLine>
      <ProfileLine>GPS tracking: {workState === "active" && trackingReady ? "Recording" : "Stopped"}</ProfileLine>
      <ProfileLine>Records waiting: {pending}</ProfileLine>
      <ProfileLine>Territory: {territoryMessage}</ProfileLine>
    </View>
    <GhostButton dark label="Sign out" onPress={onLogout} />
  </>;
}

function Nav({ screen, setScreen }: { screen: Screen; setScreen: (screen: Screen) => void }) {
  const items: { key: Screen; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "route", label: "Visits" },
    { key: "order", label: "Order" },
    { key: "sync", label: "Activity" },
    { key: "profile", label: "Profile" },
  ];
  return <View accessibilityRole="tablist" className="mx-3.5 mb-2 flex-row rounded-2xl bg-ink p-1.5">
    {items.map((item) => <TouchableOpacity
      key={item.key}
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: screen === item.key }}
      className={classes(
        "min-h-12 flex-1 items-center justify-center rounded-xl border",
        screen === item.key ? "border-gold bg-[#24324E]" : "border-transparent",
      )}
      onPress={() => setScreen(item.key)}
    >
      <Text className={classes("text-[11px] font-extrabold", screen === item.key ? "text-gold" : "text-[#AAB3C5]")}>{item.label}</Text>
    </TouchableOpacity>)}
  </View>;
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    className={classes(
      "min-h-12 items-center justify-center rounded-[9px] bg-gold px-4 py-3",
      disabled && "opacity-45",
    )}
    onPress={onPress}
    disabled={disabled}
  >
    <Text className="font-black text-ink">{label}</Text>
  </TouchableOpacity>;
}

function GhostButton({ label, onPress, dark = false }: { label: string; onPress: () => void; dark?: boolean }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    className={classes(
      "min-h-12 items-center justify-center rounded-[9px] border px-4 py-3",
      dark ? "border-ink" : "border-[#7081A8]",
    )}
    onPress={onPress}
  >
    <Text className={classes("font-black", dark ? "text-ink" : "text-white")}>{label}</Text>
  </TouchableOpacity>;
}

function CompactButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={`Move visit ${label.toLowerCase()}`}
    accessibilityState={{ disabled }}
    className={classes("min-h-8 min-w-12 items-center justify-center rounded-md bg-[#E6ECF8] px-2", disabled && "opacity-35")}
    disabled={disabled}
    onPress={onPress}
  >
    <Text className="text-[10px] font-extrabold text-field">{label}</Text>
  </TouchableOpacity>;
}

function EvidenceButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    className={classes(
      "min-h-14 flex-1 items-center justify-center rounded-[10px] border p-3",
      active ? "border-success bg-[#E9F5EF]" : "border-line bg-white",
    )}
    onPress={onPress}
  >
    <Text className="text-center font-extrabold text-ink">{label}</Text>
  </TouchableOpacity>;
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return <TouchableOpacity
    accessibilityRole="radio"
    accessibilityLabel={label}
    accessibilityState={{ checked: selected }}
    className={classes(
      "min-h-12 justify-center rounded-full border px-3.5 py-2.5",
      selected ? "border-ink bg-ink" : "border-line bg-white",
    )}
    onPress={onPress}
  >
    <Text className={classes("font-bold", selected ? "text-white" : "text-ink")}>{label}</Text>
  </TouchableOpacity>;
}

function FieldInput({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  keyboardType?: "default" | "phone-pad" | "decimal-pad";
}) {
  return <TextInput
    accessibilityLabel={label}
    className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
    value={value}
    onChangeText={onChangeText}
    keyboardType={keyboardType}
    placeholder={placeholder}
    placeholderTextColor="#697184"
  />;
}

function Stat({ value, label }: { value: string; label: string }) {
  return <View>
    <Text className="text-lg font-black text-ink">{value}</Text>
    <Text className="mt-1 text-[11px] text-muted">{label}</Text>
  </View>;
}

function Status({ status }: { status: VisitStatus }) {
  return <Text className={classes(
    "text-[9px] font-black uppercase",
    status === "completed" ? "text-success" : status === "active" ? "text-[#9A6300]" : "text-muted",
  )}>{status}</Text>;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <Text className="text-[10px] font-black tracking-[1.1px] text-muted">{children}</Text>;
}

function ScreenTitle({ children }: { children: React.ReactNode }) {
  return <Text accessibilityRole="header" className="text-[32px] font-black text-ink">{children}</Text>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text accessibilityRole="header" className="mt-1 text-[19px] font-black text-ink">{children}</Text>;
}

function InputLabel({ children }: { children: React.ReactNode }) {
  return <Text className="mt-1 text-[10px] font-black tracking-wider text-muted">{children}</Text>;
}

function BodyText({ children }: { children: React.ReactNode }) {
  return <Text className="leading-5 text-muted">{children}</Text>;
}

function InfoNotice({ title, body }: { title: string; body: string }) {
  return <View className="rounded-lg border-l-4 border-success bg-[#E9EEE8] p-4">
    <Text className="font-black text-ink">{title}</Text>
    <Text className="mt-1 leading-5 text-[#586273]">{body}</Text>
  </View>;
}

function WarningNotice({ title, body }: { title: string; body: string }) {
  return <View accessibilityRole="alert" className="rounded-lg border-l-4 border-gold bg-[#FFF1D0] p-3.5">
    <Text className="font-black text-ink">{title}</Text>
    <Text className="mt-1 leading-5 text-[#6C570F]">{body}</Text>
  </View>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <View className="items-center rounded-xl bg-[#E9EEE8] p-7">
    <Text className="text-center text-xl font-black text-ink">{title}</Text>
    <Text className="mt-1.5 text-center leading-5 text-[#586273]">{body}</Text>
  </View>;
}

function ProfileLine({ children }: { children: React.ReactNode }) {
  return <Text className="border-t border-line pt-3 font-bold leading-5 text-ink">{children}</Text>;
}
