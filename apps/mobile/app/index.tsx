import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { distanceMeters } from "@fieldops/domain";
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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import {
  clearTrackingSession,
  flushLocationQueue,
  locationQueueCount,
  queueLocationObjects,
  setTrackingSession,
  startRouteTracking,
  stopRouteTracking,
} from "../lib/background-location";

type Screen = "today" | "route" | "new_visit" | "visit" | "order" | "sync" | "profile";
type VisitStatus = "planned" | "active" | "completed";
type WorkState = "not_started" | "active" | "finished";
type Session = { token: string; expiresAt: string; employee: { id: string; name: string; code: string } };
type JsonOperation = { type: "json"; path: string; body: Record<string, unknown> };
type VisitCompletionOperation = {
  type: "visit_complete";
  path: string;
  fields: Record<string, string>;
  photo: { uri: string; name: string; type: string };
  audio: { uri: string; name: string; type: string };
};
type OfflineOperation = JsonOperation | VisitCompletionOperation;
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
};
type ActiveVisit = { id: string; outletId: string };
type PermissionState = { foreground: boolean; background: boolean; camera: boolean; microphone: boolean; services: boolean };
type PersistedState = {
  session: Session | null;
  workState: WorkState;
  outlets: Outlet[];
  queue: QueueItem[];
  activeVisit: ActiveVisit | null;
};

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
export const STORAGE_KEY = "fieldops-production-state-v2";
const GEOFENCE_METERS = 70;
const emptyPermissions: PermissionState = { foreground: false, background: false, camera: false, microphone: false, services: false };

function operationId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`.slice(0, 36);
}

function pakistanWorkDate(value = new Date()) {
  return new Date(value.valueOf() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseState(saved: string): PersistedState | null {
  try {
    const value = JSON.parse(saved) as Partial<PersistedState>;
    if (!value || !Array.isArray(value.outlets) || !Array.isArray(value.queue)) return null;
    return {
      session: value.session ?? null,
      workState: value.workState ?? "not_started",
      outlets: value.outlets.map((outlet) => ({
        ...outlet,
        kind: outlet.kind === "self" ? "self" : "assigned",
        workDate: outlet.workDate || pakistanWorkDate(),
      })),
      queue: value.queue.filter((item) => item?.state === "confirmed" || Boolean(item?.operation)),
      activeVisit: value.activeVisit ?? null,
    };
  } catch {
    return null;
  }
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
  const insets = useSafeAreaInsets();
  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("today");
  const [workState, setWorkState] = useState<WorkState>("not_started");
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeVisit, setActiveVisit] = useState<ActiveVisit | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [outcome, setOutcome] = useState("Order placed");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const audioRecorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: "document" });
  const [recording, setRecording] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState>(emptyPermissions);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [locationPending, setLocationPending] = useState(0);
  const queueRef = useRef<QueueItem[]>([]);
  const syncingRef = useRef(false);
  const permissionPrompted = useRef(false);

  const selected = outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];
  const assignedOutlets = outlets.filter((outlet) => outlet.kind === "assigned");
  const selfVisits = outlets.filter((outlet) => outlet.kind === "self");
  const completed = assignedOutlets.filter((outlet) => outlet.status === "completed").length;
  const pending = queue.filter((item) => item.state === "failed" || item.state === "pending" || item.state === "syncing").length + locationPending;
  const nextOutlet = useMemo(() => outlets.find((outlet) => outlet.kind === "assigned" && outlet.status !== "completed"), [outlets]);
  const permissionReady = permissionState.foreground && permissionState.background && permissionState.camera && permissionState.microphone;
  const trackingReady = permissionState.foreground && permissionState.background && permissionState.services;
  const workActuallyRunning = workState === "active" && trackingReady;

  function setQueueNow(update: (items: QueueItem[]) => QueueItem[]) {
    const next = update(queueRef.current).slice(-120);
    queueRef.current = next;
    setQueue(next);
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
      if (value.activeVisit) setSelectedId(value.activeVisit.outletId);
      else if (value.outlets[0]) setSelectedId(value.outlets[0].id);
    }).finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ session, workState, outlets, queue, activeVisit })).catch(() => undefined);
  }, [activeVisit, hydrated, outlets, queue, session, workState]);

  useEffect(() => {
    if (!hydrated || !session) return;
    refreshPermissions(false).then(() => {
      if (!permissionPrompted.current) {
        permissionPrompted.current = true;
        return requestAllPermissions();
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
    setTrackingSession({ token: session.token, employeeId: session.employee.id }, true).catch(() => undefined);
    if (trackingReady) startRouteTracking({ token: session.token, employeeId: session.employee.id }).catch(() => undefined);
  }, [session?.token, trackingReady, workState]);

  useEffect(() => {
    if (!hydrated || !session) return;
    const timer = setInterval(() => {
      refreshPermissions(false).catch(() => undefined);
      syncOperations().catch(() => undefined);
      flushLocationQueue(session.token).then(() => refreshLocationCount()).catch(() => undefined);
    }, 15_000);
    const appSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshPermissions(false).catch(() => undefined);
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      if (state.isConnected) {
        syncOperations().catch(() => undefined);
        flushLocationQueue(session.token).then(() => refreshLocationCount()).catch(() => undefined);
        refreshContext(false).catch(() => undefined);
      }
    });
    return () => { clearInterval(timer); appSubscription.remove(); networkSubscription(); };
  }, [hydrated, session?.token]);

  async function refreshLocationCount() {
    setLocationPending(await locationQueueCount());
  }

  async function refreshPermissions(markChecked = true) {
    const [foreground, background, camera, microphone, services] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
      ImagePicker.getCameraPermissionsAsync(),
      getRecordingPermissionsAsync(),
      Location.hasServicesEnabledAsync(),
    ]);
    setPermissionState({
      foreground: foreground.granted,
      background: background.granted,
      camera: camera.granted,
      microphone: microphone.granted,
      services,
    });
    if (markChecked) setPermissionChecked(true);
  }

  async function requestAllPermissions() {
    setPermissionBusy(true);
    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.granted) await Location.requestBackgroundPermissionsAsync();
      await ImagePicker.requestCameraPermissionsAsync();
      await requestRecordingPermissionsAsync();
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
          setQueueNow((items) => items.map((entry) => entry.id === item.id ? { ...entry, state: "confirmed", operation: undefined, error: undefined } : entry));
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
    const item: QueueItem = { id: operationId("event"), label, state: "pending", createdAt: new Date().toISOString(), attempts: 0, operation };
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
      setOutlets(merged);
      const hasPendingAttendance = queueRef.current.some((item) => item.operation?.type === "json" && item.operation.path === "/attendance" && item.state !== "confirmed");
      if (!hasPendingAttendance) setWorkState(context.workState ?? (context.shiftActive ? "active" : "not_started"));
      setSelectedId((current) => merged.some((item) => item.id === current) ? current : (merged[0]?.id ?? ""));
      if (showMessage) Alert.alert("Visits refreshed", `${context.route.length} assigned visits downloaded.`);
    } catch (error) {
      if (showMessage) Alert.alert("Working offline", error instanceof Error ? error.message : "Could not refresh assigned visits.");
    } finally {
      setRefreshing(false);
    }
  }

  async function signIn(email: string, password: string) {
    const result = await jsonRequest("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setSession(result);
    permissionPrompted.current = false;
    setScreen("today");
  }

  async function gps(accuracy = Location.Accuracy.High) {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) throw new Error("Location permission is off. Open Settings and allow location access.");
    if (!await Location.hasServicesEnabledAsync()) throw new Error("GPS is off. Turn on Location Services to continue.");
    return Location.getCurrentPositionAsync({ accuracy });
  }

  async function startWork() {
    if (!session) return;
    await refreshPermissions();
    if (!permissionState.foreground || !permissionState.background) {
      Alert.alert("Location access required", "Allow Always/background location before starting work.");
      return;
    }
    try {
      const point = await gps(Location.Accuracy.High);
      const capturedAt = new Date(point.timestamp).toISOString();
      setWorkState("active");
      await queueLocationObjects([point], "foreground");
      await startRouteTracking({ token: session.token, employeeId: session.employee.id });
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
    try {
      const point = await gps(Location.Accuracy.High);
      const capturedAt = new Date(point.timestamp).toISOString();
      await queueLocationObjects([point], "foreground");
      enqueue("Finish today's work", { type: "json", path: "/attendance", body: {
        action: "check_out",
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("finish"),
      } });
      setWorkState("finished");
      await stopRouteTracking();
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
      Alert.alert("Work is stopped", trackingReady ? "Tap Start work before beginning a visit." : "Turn on GPS and allow background location first.");
      return;
    }
    try {
      const point = await gps();
      const distance = Math.round(distanceMeters(
        { latitude: outlet.latitude, longitude: outlet.longitude },
        { latitude: point.coords.latitude, longitude: point.coords.longitude },
      ));
      if (distance > GEOFENCE_METERS) {
        Alert.alert("Move closer to the visit", `You are ${distance} m away. Visit check-in is allowed within ${GEOFENCE_METERS} m.`);
        return;
      }
      const visitId = operationId("visit");
      const capturedAt = new Date(point.timestamp).toISOString();
      enqueue(`${outlet.name} check-in · ${distance} m`, { type: "json", path: "/visits/check-in", body: {
        visitId,
        visitType: "assigned",
        outletId: outlet.id,
        routeId: outlet.routeId,
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("visit_checkin"),
      } });
      setActiveVisit({ id: visitId, outletId: outlet.id });
      setSelectedId(outlet.id);
      setOutlets((items) => items.map((item) => item.id === outlet.id ? { ...item, status: "active" } : item));
      setPhoto(null);
      setAudioUri(null);
      setNotes("");
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
      Alert.alert("Work is stopped", trackingReady ? "Tap Start work before beginning a visit." : "Turn on GPS and allow background location first.");
      return;
    }
    try {
      const point = await gps();
      const visitId = operationId("visit");
      const capturedAt = new Date(point.timestamp).toISOString();
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
      enqueue(`${customerName} self-created visit check-in`, { type: "json", path: "/visits/check-in", body: {
        visitId,
        visitType: "self_initiated",
        customerName,
        customerAddress,
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("visit_checkin"),
      } });
      setOutlets((items) => [...items, visit]);
      setActiveVisit({ id: visitId, outletId: visitId });
      setSelectedId(visitId);
      setPhoto(null);
      setAudioUri(null);
      setNotes("");
      setScreen("visit");
    } catch (error) {
      Alert.alert("Visit did not start", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function takePhoto() {
    if (!(await ImagePicker.getCameraPermissionsAsync()).granted) {
      Alert.alert("Camera permission required", "Open Settings and allow camera access.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.72 });
    if (!result.canceled) {
      const asset = result.assets[0];
      const uri = await preserveEvidence(asset.uri, "jpg");
      setPhoto({ ...asset, uri, fileName: asset.fileName ?? `visit-${activeVisit?.id}.jpg`, mimeType: asset.mimeType ?? "image/jpeg" });
    }
  }

  async function toggleRecording() {
    if (recording) {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      setRecording(false);
      if (uri) setAudioUri(await preserveEvidence(uri, "m4a"));
      return;
    }
    if (!(await getRecordingPermissionsAsync()).granted) {
      Alert.alert("Microphone permission required", "Open Settings and allow microphone access.");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
    setRecording(true);
  }

  async function finishVisit() {
    if (!session || !selected || !activeVisit || activeVisit.outletId !== selected.id) {
      Alert.alert("Start the visit first", "Check in with GPS before completing the visit.");
      return;
    }
    if (!photo || !audioUri) {
      Alert.alert("Photo and audio required", "Take one visit photo and record an audio note before finishing.");
      return;
    }
    try {
      const point = await gps();
      const distance = Math.round(distanceMeters(
        { latitude: selected.latitude, longitude: selected.longitude },
        { latitude: point.coords.latitude, longitude: point.coords.longitude },
      ));
      if (distance > GEOFENCE_METERS) {
        Alert.alert("Return to the visit location", `You are ${distance} m away. Finish the visit within ${GEOFENCE_METERS} m.`);
        return;
      }
      const capturedAt = new Date(point.timestamp).toISOString();
      enqueue(`${selected.name} completion`, {
        type: "visit_complete",
        path: `/visits/${activeVisit.id}/complete`,
        fields: {
          outcome,
          notes,
          latitude: String(point.coords.latitude),
          longitude: String(point.coords.longitude),
          accuracy: String(point.coords.accuracy ?? 0),
          capturedAt,
          idempotencyKey: operationId("visit_complete"),
        },
        photo: { uri: photo.uri, name: photo.fileName ?? `visit-${activeVisit.id}.jpg`, type: photo.mimeType ?? "image/jpeg" },
        audio: { uri: audioUri, name: `visit-${activeVisit.id}.m4a`, type: "audio/m4a" },
      });
      setOutlets((items) => items.map((item) => item.id === selected.id ? { ...item, status: "completed" } : item));
      setActiveVisit(null);
      setPhoto(null);
      setAudioUri(null);
      setScreen("route");
      Alert.alert("Visit saved", "The photo, audio, notes, and location are saved on this phone and will upload automatically.");
    } catch (error) {
      Alert.alert("Visit not finished", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function createOrder(order: OrderDraft) {
    if (!session) return;
    try {
      const point = await gps(Location.Accuracy.Balanced);
      const capturedAt = new Date(point.timestamp).toISOString();
      enqueue(`Order · ${order.customerName}`, { type: "json", path: "/orders", body: {
        ...order,
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("order"),
      } });
      Alert.alert("Order saved", "This order can be taken from any location and will sync automatically.");
      setScreen("today");
    } catch (error) {
      Alert.alert("Order location unavailable", error instanceof Error ? error.message : "Turn on GPS and try again.");
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
    await stopRouteTracking().catch(() => undefined);
    await clearTrackingSession();
    setSession(null);
    setOutlets([]);
    setQueueNow(() => []);
    setWorkState("not_started");
    setActiveVisit(null);
    setScreen("today");
  }

  if (!hydrated) return <SafeAreaView style={styles.safe} edges={["top", "bottom"]}><View style={styles.loading}><Text style={styles.title}>Loading FieldOPS…</Text></View></SafeAreaView>;
  if (!session) return <Login onSubmit={signIn} />;
  if (!permissionChecked || !permissionReady) return <PermissionGate state={permissionState} busy={permissionBusy} onRequest={requestAllPermissions} onSettings={() => Linking.openSettings()} onLogout={signOut} />;

  return <SafeAreaView style={styles.safe} edges={["top"]}><View style={styles.app}><ScrollView contentContainerStyle={[styles.page, { paddingBottom: 110 + insets.bottom }]} keyboardShouldPersistTaps="handled">
    <Header pending={pending} refreshing={refreshing} onSync={() => setScreen("sync")} onRefresh={() => refreshContext()} />
    {screen === "today" && <Today workState={workState} trackingReady={trackingReady} completed={completed} total={assignedOutlets.length} selfVisitCount={selfVisits.length} nextOutlet={nextOutlet} onStartWork={startWork} onFinishWork={finishWork} onFixGps={() => Linking.openSettings()} onStartVisit={() => nextOutlet && startVisit(nextOutlet)} onNewVisit={() => setScreen("new_visit")} onRoute={() => setScreen("route")} onOrder={() => setScreen("order")} />}
    {screen === "route" && <Route assigned={assignedOutlets} selfVisits={selfVisits} onNewVisit={() => setScreen("new_visit")} onSelect={(id) => { setSelectedId(id); setScreen("visit"); }} onMove={moveOutlet} />}
    {screen === "new_visit" && <NewVisit running={workActuallyRunning} onSubmit={startUnplannedVisit} onBack={() => setScreen("route")} />}
    {screen === "visit" && selected && <Visit outlet={selected} activeVisit={activeVisit?.outletId === selected.id} outcome={outcome} setOutcome={setOutcome} notes={notes} setNotes={setNotes} photo={photo} audioUri={audioUri} recording={Boolean(recording)} onStart={() => startVisit(selected)} onPhoto={takePhoto} onAudio={toggleRecording} onFinish={finishVisit} />}
    {screen === "order" && <Order outlets={assignedOutlets} onSubmit={createOrder} />}
    {screen === "sync" && <SyncQueue queue={queue} locationPending={locationPending} onRetry={retryEverything} />}
    {screen === "profile" && <Profile session={session} workState={workState} trackingReady={trackingReady} pending={pending} onLogout={signOut} />}
  </ScrollView><Nav screen={screen} setScreen={setScreen} bottomInset={insets.bottom} /></View></SafeAreaView>;
}

function Login({ onSubmit }: { onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return <SafeAreaView style={styles.safe} edges={["top", "bottom"]}><ScrollView contentContainerStyle={styles.loginPage} keyboardShouldPersistTaps="handled"><View style={styles.loginBrand}><Text style={styles.loginMark}>YR</Text><Text style={styles.loginTitle}>Yousuf Rice FieldOps</Text><Text style={styles.loginBody}>Start work, follow assigned visits, capture required evidence, take orders anywhere, and keep your route safe offline.</Text></View><View style={styles.loginCard}><Text style={styles.eyebrow}>SALESPERSON SIGN IN</Text><TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="Your work email" /><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" placeholder="Your separate password" /><Button label={busy ? "Signing in…" : "Sign in"} disabled={busy} onPress={async () => { setBusy(true); try { await onSubmit(email.trim(), password); } catch (error) { Alert.alert("Sign in failed", error instanceof Error ? error.message : "Try again."); } finally { setBusy(false); } }} /></View></ScrollView></SafeAreaView>;
}

function PermissionGate({ state, busy, onRequest, onSettings, onLogout }: { state: PermissionState; busy: boolean; onRequest: () => void; onSettings: () => void; onLogout: () => void }) {
  return <SafeAreaView style={styles.safe} edges={["top", "bottom"]}><ScrollView contentContainerStyle={styles.permissionPage}><Text style={styles.eyebrow}>BEFORE WORK STARTS</Text><Text style={styles.screenTitle}>Allow field permissions</Text><Text style={styles.lede}>FieldOPS asks up front because route tracking, visit photos, and audio notes cannot be completed without them.</Text><View style={styles.permissionCard}><PermissionRow label="Location while using the app" ready={state.foreground} /><PermissionRow label="Background / Always location" ready={state.background} /><PermissionRow label="Camera" ready={state.camera} /><PermissionRow label="Microphone" ready={state.microphone} /><PermissionRow label="GPS / Location Services" ready={state.services} /></View><Button label={busy ? "Checking permissions…" : "Allow required permissions"} disabled={busy} onPress={onRequest} /><GhostButton dark label="Open phone settings" onPress={onSettings} /><GhostButton dark label="Sign out" onPress={onLogout} /></ScrollView></SafeAreaView>;
}

function PermissionRow({ label, ready }: { label: string; ready: boolean }) { return <View style={styles.permissionRow}><View style={[styles.permissionDot, ready && styles.permissionDotReady]} /><Text style={styles.permissionLabel}>{label}</Text><Text style={[styles.permissionStatus, ready && styles.permissionStatusReady]}>{ready ? "Allowed" : "Required"}</Text></View>; }

function Header({ pending, refreshing, onSync, onRefresh }: { pending: number; refreshing: boolean; onSync: () => void; onRefresh: () => void }) { return <View style={styles.header}><View style={styles.grow}><Text style={styles.eyebrow}>YOUSUF RICE · FIELDOPS</Text><Text style={styles.title}>Today’s field work</Text></View><View style={styles.headerActions}><TouchableOpacity style={styles.refreshPill} onPress={onRefresh}><Text style={styles.refreshText}>{refreshing ? "…" : "Refresh"}</Text></TouchableOpacity><TouchableOpacity style={styles.syncPill} onPress={onSync}><Text style={styles.syncText}>{pending} pending</Text></TouchableOpacity></View></View>; }

function Today({ workState, trackingReady, completed, total, selfVisitCount, nextOutlet, onStartWork, onFinishWork, onFixGps, onStartVisit, onNewVisit, onRoute, onOrder }: { workState: WorkState; trackingReady: boolean; completed: number; total: number; selfVisitCount: number; nextOutlet?: Outlet; onStartWork: () => void; onFinishWork: () => void; onFixGps: () => void; onStartVisit: () => void; onNewVisit: () => void; onRoute: () => void; onOrder: () => void }) {
  const running = workState === "active" && trackingReady;
  const title = workState === "finished" ? "Today’s work finished" : running ? "Work in progress" : workState === "active" ? "Work stopped" : "Ready to start";
  const detail = workState === "active" && !trackingReady ? "GPS or background location is off" : running ? "Route recording every minute" : workState === "finished" ? "Tracking ended for today" : "GPS starts with your work";
  return <><View style={[styles.shiftCard, running && styles.shiftCardLive, workState === "active" && !trackingReady && styles.shiftCardStopped]}><View style={styles.grow}><Text style={styles.darkLabel}>TODAY · WORK STATUS</Text><Text style={styles.shiftValue}>{title}</Text><Text style={styles.shiftDetail}>{detail}</Text></View>{workState === "not_started" && <Button label="Start work" onPress={onStartWork} />}{workState === "active" && trackingReady && <Button label="Finish today" onPress={onFinishWork} />}{workState === "active" && !trackingReady && <Button label="Fix GPS" onPress={onFixGps} />}</View><Text style={styles.sectionTitle}>Assigned commitments</Text><View style={styles.stats}><Stat value={`${completed}/${total}`} label="Completed" /><Stat value={`${Math.max(0, total - completed)}`} label="Still assigned" /><Stat value={running ? "Live" : "Stopped"} label="Route tracking" /></View>{nextOutlet ? <View style={styles.hero}><Text style={styles.heroKicker}>NEXT ASSIGNED VISIT · {GEOFENCE_METERS} M CHECK-IN</Text><Text style={styles.heroTitle}>{nextOutlet.name}</Text><Text style={styles.heroBody}>{nextOutlet.address}</Text><View style={styles.actionRow}><Button label="Start assigned visit" disabled={!running} onPress={onStartVisit} /><GhostButton label="All assigned visits" onPress={onRoute} /></View></View> : <View style={styles.empty}><Text style={styles.cardTitle}>No assigned visits waiting</Text><Text style={styles.noticeBody}>You can still add your own customer visit while work and GPS tracking are active.</Text></View>}<TouchableOpacity style={[styles.fieldVisitBanner, !running && styles.disabled]} disabled={!running} onPress={onNewVisit}><View><Text style={styles.fieldVisitLabel}>SALESPERSON-ADDED · {selfVisitCount} TODAY</Text><Text style={styles.fieldVisitTitle}>Visit any customer</Text><Text style={styles.fieldVisitBody}>GPS, photo and audio are required</Text></View><Text style={styles.fieldVisitArrow}>＋</Text></TouchableOpacity><TouchableOpacity style={styles.orderBanner} onPress={onOrder}><View><Text style={styles.orderBannerLabel}>QUICK ORDER</Text><Text style={styles.orderBannerTitle}>Take an order anywhere</Text></View><Text style={styles.orderArrow}>→</Text></TouchableOpacity><View style={styles.notice}><Text style={styles.noticeTitle}>Offline-safe route</Text><Text style={styles.noticeBody}>Assigned status stays visible. Self-created visits, minute-by-minute GPS, photos, audio, and orders stay on this phone until the server confirms them.</Text></View></>;
}

function Route({ assigned, selfVisits, onSelect, onMove, onNewVisit }: { assigned: Outlet[]; selfVisits: Outlet[]; onSelect: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void; onNewVisit: () => void }) { return <><Text style={styles.screenTitle}>Today’s visits</Text><Text style={styles.lede}>Management assignments remain here until completed. You can also record a customer visit that was not assigned.</Text><Button label="＋ Add unplanned customer visit" onPress={onNewVisit} /><Text style={styles.sectionTitle}>Assigned by management</Text>{assigned.length > 0 && <RouteMap outlets={assigned} />}{assigned.length === 0 && <View style={styles.empty}><Text style={styles.cardTitle}>No assigned visits</Text><Text style={styles.noticeBody}>You can still add your own visit above.</Text></View>}{assigned.map((outlet, index) => <View key={outlet.id} style={styles.listRow}><Text style={styles.index}>{String(index + 1).padStart(2, "0")}</Text><TouchableOpacity style={styles.grow} onPress={() => onSelect(outlet.id)}><Text style={styles.rowTitle}>{outlet.name}</Text><Text style={styles.rowMeta}>{outlet.address}</Text></TouchableOpacity><View style={styles.reorder}><TouchableOpacity disabled={index === 0} onPress={() => onMove(outlet.id, -1)}><Text style={[styles.arrow, index === 0 && styles.arrowDisabled]}>↑</Text></TouchableOpacity><TouchableOpacity disabled={index === assigned.length - 1} onPress={() => onMove(outlet.id, 1)}><Text style={[styles.arrow, index === assigned.length - 1 && styles.arrowDisabled]}>↓</Text></TouchableOpacity></View><Status status={outlet.status} /></View>)}<Text style={styles.sectionTitle}>Added by you</Text>{selfVisits.length === 0 ? <View style={styles.selfEmpty}><Text style={styles.noticeBody}>No unplanned visits recorded today.</Text></View> : selfVisits.map((outlet) => <TouchableOpacity key={outlet.id} style={styles.selfVisitRow} onPress={() => onSelect(outlet.id)}><View style={styles.selfVisitMark}><Text style={styles.selfVisitMarkText}>＋</Text></View><View style={styles.grow}><Text style={styles.rowTitle}>{outlet.name}</Text><Text style={styles.rowMeta}>{outlet.address}</Text></View><Status status={outlet.status} /></TouchableOpacity>)}</>; }

function NewVisit({ running, onSubmit, onBack }: { running: boolean; onSubmit: (customerName: string, customerAddress: string) => Promise<void>; onBack: () => void }) {
  const [customerName, setCustomerName] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [busy, setBusy] = useState(false);
  return <><Text style={styles.eyebrow}>SALESPERSON-ADDED VISIT</Text><Text style={styles.screenTitle}>Visit any customer</Text><Text style={styles.lede}>No assignment is needed. Starting captures this location as the visit point; finishing requires you to remain within {GEOFENCE_METERS} m and attach both photo and audio evidence.</Text>{!running && <View style={styles.requiredNotice}><Text style={styles.requiredTitle}>Start work and GPS first</Text><Text style={styles.requiredBody}>Unplanned visits can only begin while today’s work and route tracking are active.</Text></View>}<View style={styles.card}><Text style={styles.inputLabel}>CUSTOMER OR SHOP NAME · REQUIRED</Text><TextInput style={styles.input} value={customerName} onChangeText={setCustomerName} placeholder="Example: Al Madina Store" autoFocus /><Text style={styles.inputLabel}>ADDRESS OR AREA · OPTIONAL</Text><TextInput style={styles.input} value={customerAddress} onChangeText={setCustomerAddress} placeholder="GPS will save the exact location" /><Button label={busy ? "Capturing GPS…" : "Start visit at this location"} disabled={busy || !running} onPress={async () => { if (!customerName.trim()) { Alert.alert("Customer name required", "Enter the customer or shop name before starting the visit."); return; } setBusy(true); try { await onSubmit(customerName.trim(), customerAddress.trim()); } finally { setBusy(false); } }} /></View><GhostButton dark label="Back to visits" onPress={onBack} /></>;
}

function RouteMap({ outlets }: { outlets: Outlet[] }) { const points = JSON.stringify(outlets.map((outlet) => ({ name: outlet.name, address: outlet.address, lat: outlet.latitude, lng: outlet.longitude }))).replaceAll("<", "\\u003c"); const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link href="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css" rel="stylesheet"><style>html,body,#map{height:100%;margin:0}.maplibregl-popup-content{font:12px system-ui;color:#17233b}</style></head><body><div id="map"></div><script src="https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js"></script><script>const points=${points};const map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[67.035,24.815],zoom:11.8});const bounds=new maplibregl.LngLatBounds();points.forEach((p,i)=>{new maplibregl.Marker({color:'#243d74'}).setLngLat([p.lng,p.lat]).setPopup(new maplibregl.Popup().setText((i+1)+'. '+p.name+' · '+p.address)).addTo(map);bounds.extend([p.lng,p.lat])});if(points.length>1)map.fitBounds(bounds,{padding:35,maxZoom:14,duration:0});</script></body></html>`; return <View style={styles.mapWrap}><WebView source={{ html }} originWhitelist={["*"]} javaScriptEnabled /></View>; }

function Visit({ outlet, activeVisit, outcome, setOutcome, notes, setNotes, photo, audioUri, recording, onStart, onPhoto, onAudio, onFinish }: { outlet: Outlet; activeVisit: boolean; outcome: string; setOutcome: (value: string) => void; notes: string; setNotes: (value: string) => void; photo: ImagePicker.ImagePickerAsset | null; audioUri: string | null; recording: boolean; onStart: () => void; onPhoto: () => void; onAudio: () => void; onFinish: () => void }) { const outcomes = ["Order placed", "Order discussed", "No order", "Shop closed", "Owner unavailable"]; const selfCreated = outlet.kind === "self"; return <><Text style={styles.eyebrow}>{selfCreated ? "SALESPERSON-ADDED VISIT" : "MANAGEMENT-ASSIGNED VISIT"}</Text><Text style={styles.screenTitle}>{outlet.name}</Text><Text style={styles.lede}>{outlet.address}</Text><View style={styles.card}><Text style={styles.eyebrow}>VISIT STATUS</Text><Text style={styles.cardTitle}>{activeVisit ? "Visit in progress" : outlet.status === "completed" ? "Visit completed" : `Ready for ${GEOFENCE_METERS} m check-in`}</Text>{!selfCreated && !activeVisit && outlet.status !== "completed" && <Button label="GPS check in" onPress={onStart} />}</View>{activeVisit && <><View style={styles.requiredNotice}><Text style={styles.requiredTitle}>Required before finishing</Text><Text style={styles.requiredBody}>Stay within {GEOFENCE_METERS} m of this visit point, take one photo, and record one audio note.</Text></View><Text style={styles.sectionTitle}>Visit outcome</Text><View style={styles.choiceWrap}>{outcomes.map((item) => <TouchableOpacity key={item} style={[styles.choice, outcome === item && styles.choiceSelected]} onPress={() => setOutcome(item)}><Text style={[styles.choiceText, outcome === item && styles.choiceTextSelected]}>{item}</Text></TouchableOpacity>)}</View><TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} placeholder="Visit notes" multiline /><View style={styles.evidenceRow}><EvidenceButton label={photo ? "✓ Photo ready" : "Take required photo"} active={Boolean(photo)} onPress={onPhoto} /><EvidenceButton label={recording ? "Stop recording" : audioUri ? "✓ Audio ready" : "Record required audio"} active={Boolean(audioUri || recording)} onPress={onAudio} /></View>{photo && <Image source={{ uri: photo.uri }} style={styles.photoPreview} />}{audioUri && <Text style={styles.confirmedLine}>Audio note is saved on this phone</Text>}<Button label="Finish visit" onPress={onFinish} /></>}</>; }

type OrderDraft = { outletId: string; customerName: string; phone: string; address: string; productName: string; quantityKg: number; unitPrice: number; notes: string };
function Order({ outlets, onSubmit }: { outlets: Outlet[]; onSubmit: (order: OrderDraft) => Promise<void> }) {
  const [outletId, setOutletId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [quantity, setQuantity] = useState("5");
  const [unitPrice, setUnitPrice] = useState("450");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const total = Math.max(0, Number(quantity) || 0) * Math.max(0, Number(unitPrice) || 0);
  return <><Text style={styles.screenTitle}>Take an order</Text><Text style={styles.lede}>Orders have no territory or geofence restriction. The capture location is saved for the date-wise management record.</Text><View style={styles.card}><Text style={styles.inputLabel}>ASSIGNED VISIT (OPTIONAL)</Text><View style={styles.choiceWrap}><TouchableOpacity style={[styles.choice, !outletId && styles.choiceSelected]} onPress={() => setOutletId("")}><Text style={[styles.choiceText, !outletId && styles.choiceTextSelected]}>Any customer</Text></TouchableOpacity>{outlets.map((outlet) => <TouchableOpacity key={outlet.id} style={[styles.choice, outletId === outlet.id && styles.choiceSelected]} onPress={() => { setOutletId(outlet.id); setCustomerName(outlet.name); setAddress(outlet.address); }}><Text style={[styles.choiceText, outletId === outlet.id && styles.choiceTextSelected]}>{outlet.name}</Text></TouchableOpacity>)}</View><Text style={styles.inputLabel}>CUSTOMER</Text><TextInput style={styles.input} value={customerName} onChangeText={setCustomerName} placeholder="Customer or shop name" /><View style={styles.fieldPair}><TextInput style={[styles.input, styles.flexInput]} value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Phone (optional)" /><TextInput style={[styles.input, styles.flexInput]} value={address} onChangeText={setAddress} placeholder="Address (optional)" /></View><Text style={styles.inputLabel}>PRODUCT</Text><TextInput style={styles.input} value="Yousuf Super Kernel Basmati" editable={false} /><View style={styles.fieldPair}><TextInput style={[styles.input, styles.flexInput]} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" placeholder="Quantity kg" /><TextInput style={[styles.input, styles.flexInput]} value={unitPrice} onChangeText={setUnitPrice} keyboardType="decimal-pad" placeholder="Price per kg" /></View><TextInput style={[styles.input, styles.notes]} value={notes} onChangeText={setNotes} placeholder="Order notes" multiline /><View style={styles.totalRow}><Text style={styles.totalLabel}>Order total</Text><Text style={styles.total}>PKR {total.toLocaleString()}</Text></View><Button label={busy ? "Saving order…" : "Save order"} disabled={busy} onPress={async () => { const quantityKg = Number(quantity), price = Number(unitPrice); if (!customerName.trim() || !Number.isFinite(quantityKg) || quantityKg <= 0 || !Number.isFinite(price) || price < 0) { Alert.alert("Complete the order", "Customer, quantity, and price are required."); return; } setBusy(true); try { await onSubmit({ outletId, customerName: customerName.trim(), phone: phone.trim(), address: address.trim(), productName: "Yousuf Super Kernel Basmati", quantityKg, unitPrice: price, notes: notes.trim() }); } finally { setBusy(false); } }} /></View></>;
}

function SyncQueue({ queue, locationPending, onRetry }: { queue: QueueItem[]; locationPending: number; onRetry: () => void }) { const pending = queue.filter((item) => item.state !== "confirmed").length + locationPending; return <><Text style={styles.screenTitle}>Offline & server activity</Text><Text style={styles.lede}>Nothing is called uploaded until the server confirms it. Failed records retry automatically when internet returns.</Text>{pending > 0 && <Button label="Retry all now" onPress={onRetry} />}<View style={styles.locationQueue}><Text style={styles.locationCount}>{locationPending}</Text><View><Text style={styles.rowTitle}>Route points waiting</Text><Text style={styles.rowMeta}>Minute-by-minute GPS saved on this phone</Text></View></View>{queue.length === 0 ? <View style={styles.empty}><Text style={styles.cardTitle}>No work activity yet</Text><Text style={styles.noticeBody}>Start work to begin the activity record.</Text></View> : [...queue].reverse().map((item) => <View key={item.id} style={styles.listRow}><View style={[styles.dot, item.state === "confirmed" && styles.dotConfirmed, (item.state === "pending" || item.state === "syncing") && styles.dotPending]} /><View style={styles.grow}><Text style={styles.rowTitle}>{item.label}</Text><Text style={styles.rowMeta}>{item.state === "confirmed" ? "Saved by server" : item.state === "syncing" ? "Uploading now" : item.error ?? "Saved on phone · waiting for internet"}</Text></View></View>)}</>; }

function Profile({ session, workState, trackingReady, pending, onLogout }: { session: Session; workState: WorkState; trackingReady: boolean; pending: number; onLogout: () => void }) { return <><Text style={styles.screenTitle}>Field profile</Text><View style={styles.card}><Text style={styles.eyebrow}>SALES REPRESENTATIVE</Text><Text style={styles.cardTitle}>{session.employee.name}</Text><Text style={styles.lede}>Employee code {session.employee.code}</Text></View><View style={styles.card}><Text style={styles.cardTitle}>Tracking & privacy</Text><Text style={styles.noticeBody}>From Start work until Finish today, FieldOPS records the work route about once per minute—even in the background—and uploads offline points when a connection returns.</Text><Text style={styles.profileLine}>Today: {workState.replace("_", " ")}</Text><Text style={styles.profileLine}>GPS tracking: {workState === "active" && trackingReady ? "Recording" : "Stopped"}</Text><Text style={styles.profileLine}>Records waiting: {pending}</Text></View><GhostButton dark label="Sign out" onPress={onLogout} /></>; }

function Nav({ screen, setScreen, bottomInset }: { screen: Screen; setScreen: (screen: Screen) => void; bottomInset: number }) { const items: { key: Screen; label: string }[] = [{ key: "today", label: "Today" }, { key: "route", label: "Visits" }, { key: "order", label: "Order" }, { key: "sync", label: "Activity" }, { key: "profile", label: "Profile" }]; return <View style={[styles.nav, { bottom: 10 + bottomInset }]}>{items.map((item) => <TouchableOpacity key={item.key} style={styles.navItem} onPress={() => setScreen(item.key)}><Text style={[styles.navText, screen === item.key && styles.navActive]}>{item.label}</Text></TouchableOpacity>)}</View>; }
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) { return <TouchableOpacity style={[styles.button, disabled && styles.disabled]} onPress={onPress} disabled={disabled}><Text style={styles.buttonText}>{label}</Text></TouchableOpacity>; }
function GhostButton({ label, onPress, dark = false }: { label: string; onPress: () => void; dark?: boolean }) { return <TouchableOpacity style={[styles.ghost, dark && styles.ghostDark]} onPress={onPress}><Text style={[styles.ghostText, dark && styles.ghostTextDark]}>{label}</Text></TouchableOpacity>; }
function EvidenceButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <TouchableOpacity style={[styles.evidenceButton, active && styles.evidenceActive]} onPress={onPress}><Text style={styles.evidenceText}>{label}</Text></TouchableOpacity>; }
function Stat({ value, label }: { value: string; label: string }) { return <View><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>; }
function Status({ status }: { status: VisitStatus }) { return <Text style={[styles.status, status === "completed" && styles.statusDone, status === "active" && styles.statusActive]}>{status}</Text>; }

const navy = "#17233B", blue = "#243D74", gold = "#D8A629", paper = "#F7F8F4", line = "#DCE0D8", muted = "#697184";
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: paper }, app: { flex: 1 }, page: { padding: 20, paddingBottom: 110, gap: 18 }, loading: { flex: 1, justifyContent: "center", alignItems: "center" }, grow: { flex: 1 },
  loginPage: { flexGrow: 1, backgroundColor: navy, padding: 24, justifyContent: "center", gap: 26 }, loginBrand: { alignItems: "center" }, loginMark: { width: 62, height: 62, borderRadius: 18, backgroundColor: gold, color: navy, textAlign: "center", textAlignVertical: "center", fontSize: 24, fontWeight: "900", paddingTop: 16 }, loginTitle: { color: "white", fontSize: 29, fontWeight: "900", marginTop: 16 }, loginBody: { color: "#BAC4D8", textAlign: "center", lineHeight: 21, maxWidth: 360, marginTop: 9 }, loginCard: { backgroundColor: "white", borderRadius: 18, padding: 20, gap: 14 },
  permissionPage: { flexGrow: 1, padding: 25, justifyContent: "center", gap: 16 }, permissionCard: { backgroundColor: "white", borderWidth: 1, borderColor: line, borderRadius: 16, paddingHorizontal: 17 }, permissionRow: { flexDirection: "row", alignItems: "center", paddingVertical: 15, borderBottomWidth: 1, borderColor: line, gap: 10 }, permissionDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#C84D3A" }, permissionDotReady: { backgroundColor: "#267057" }, permissionLabel: { flex: 1, color: navy, fontWeight: "800" }, permissionStatus: { color: "#A53B2E", fontSize: 11, fontWeight: "900" }, permissionStatusReady: { color: "#267057" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }, headerActions: { flexDirection: "row", gap: 6 }, eyebrow: { fontSize: 10, fontWeight: "900", letterSpacing: 1.1, color: muted }, title: { fontSize: 26, fontWeight: "800", color: navy, marginTop: 4 }, syncPill: { backgroundColor: "#FFF1D0", paddingHorizontal: 9, paddingVertical: 7, borderRadius: 99 }, syncText: { color: "#805C00", fontSize: 10, fontWeight: "900" }, refreshPill: { backgroundColor: "#E6ECF8", paddingHorizontal: 9, paddingVertical: 7, borderRadius: 99 }, refreshText: { color: blue, fontSize: 10, fontWeight: "900" },
  shiftCard: { backgroundColor: navy, borderRadius: 16, padding: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, borderLeftWidth: 5, borderLeftColor: "#95A0B5" }, shiftCardLive: { borderLeftColor: "#52B889" }, shiftCardStopped: { borderLeftColor: "#D05242" }, darkLabel: { color: "#AAB3C5", fontSize: 10, fontWeight: "900" }, shiftValue: { color: "white", fontSize: 18, fontWeight: "900", marginTop: 4 }, shiftDetail: { color: "#BAC4D8", fontSize: 11, marginTop: 4 }, button: { backgroundColor: gold, paddingHorizontal: 17, paddingVertical: 13, borderRadius: 9, alignItems: "center" }, disabled: { opacity: 0.48 }, buttonText: { fontWeight: "900", color: navy },
  sectionTitle: { fontSize: 19, fontWeight: "900", color: navy, marginTop: 5 }, stats: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderBottomWidth: 1, borderColor: line, paddingVertical: 16 }, statValue: { fontSize: 19, fontWeight: "900", color: navy }, statLabel: { fontSize: 11, color: muted, marginTop: 3 },
  hero: { backgroundColor: blue, borderRadius: 16, padding: 20 }, heroKicker: { fontSize: 10, fontWeight: "900", letterSpacing: 1, color: "#B6C2DF" }, heroTitle: { fontSize: 25, fontWeight: "900", color: "white", marginTop: 10 }, heroBody: { color: "#C2CBE0", marginTop: 6 }, actionRow: { flexDirection: "row", gap: 10, marginTop: 20, flexWrap: "wrap" }, ghost: { borderWidth: 1, borderColor: "#7081A8", paddingHorizontal: 17, paddingVertical: 12, borderRadius: 9, alignItems: "center" }, ghostDark: { borderColor: navy }, ghostText: { color: "white", fontWeight: "900" }, ghostTextDark: { color: navy },
  fieldVisitBanner: { backgroundColor: "#E4F2EA", borderWidth: 1, borderColor: "#267057", borderRadius: 14, padding: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, fieldVisitLabel: { color: "#267057", fontSize: 10, fontWeight: "900", letterSpacing: 0.8 }, fieldVisitTitle: { color: navy, fontSize: 21, fontWeight: "900", marginTop: 4 }, fieldVisitBody: { color: "#4F655C", fontSize: 12, marginTop: 4 }, fieldVisitArrow: { color: "#267057", fontSize: 31, fontWeight: "500" },
  orderBanner: { backgroundColor: gold, borderRadius: 14, padding: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, orderBannerLabel: { color: "#5F4600", fontSize: 10, fontWeight: "900", letterSpacing: 1 }, orderBannerTitle: { color: navy, fontSize: 19, fontWeight: "900", marginTop: 4 }, orderArrow: { color: navy, fontSize: 27, fontWeight: "900" }, notice: { backgroundColor: "#E9EEE8", borderLeftWidth: 4, borderLeftColor: "#267057", padding: 16, borderRadius: 8 }, noticeTitle: { fontWeight: "900", color: navy }, noticeBody: { color: "#586273", lineHeight: 20, marginTop: 5 }, screenTitle: { fontSize: 32, fontWeight: "900", color: navy }, lede: { color: muted, lineHeight: 20 },
  mapWrap: { height: 265, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: line }, listRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 15, borderBottomWidth: 1, borderColor: line }, selfVisitRow: { flexDirection: "row", alignItems: "center", gap: 11, padding: 14, backgroundColor: "#F0F7F3", borderRadius: 12, marginBottom: 8 }, selfVisitMark: { width: 29, height: 29, borderRadius: 15, backgroundColor: "#267057", alignItems: "center", justifyContent: "center" }, selfVisitMarkText: { color: "white", fontSize: 18, fontWeight: "800" }, selfEmpty: { padding: 16, borderWidth: 1, borderStyle: "dashed", borderColor: line, borderRadius: 10 }, index: { width: 28, color: "#9A7A23", fontWeight: "900" }, rowTitle: { color: navy, fontWeight: "800" }, rowMeta: { color: muted, fontSize: 12, marginTop: 4 }, status: { fontSize: 9, fontWeight: "900", color: muted, textTransform: "uppercase" }, statusDone: { color: "#267057" }, statusActive: { color: "#9A6300" }, reorder: { flexDirection: "row", gap: 2 }, arrow: { fontSize: 20, color: blue, fontWeight: "900", padding: 4 }, arrowDisabled: { color: "#C9CEC7" },
  card: { backgroundColor: "white", borderWidth: 1, borderColor: line, borderRadius: 14, padding: 18, gap: 13 }, cardTitle: { fontSize: 21, fontWeight: "900", color: navy }, requiredNotice: { backgroundColor: "#FFF1D0", borderLeftWidth: 4, borderLeftColor: gold, padding: 14, borderRadius: 8 }, requiredTitle: { color: navy, fontWeight: "900" }, requiredBody: { color: "#6C570F", marginTop: 4, lineHeight: 19 }, choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 9 }, choice: { borderWidth: 1, borderColor: line, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 10 }, choiceSelected: { backgroundColor: navy, borderColor: navy }, choiceText: { color: navy, fontWeight: "700" }, choiceTextSelected: { color: "white" }, inputLabel: { fontSize: 10, fontWeight: "900", color: muted, letterSpacing: 1, marginTop: 7 }, input: { borderWidth: 1, borderColor: line, borderRadius: 9, padding: 13, fontSize: 16, color: navy, backgroundColor: "white" }, notes: { minHeight: 88, textAlignVertical: "top" }, fieldPair: { flexDirection: "row", gap: 10 }, flexInput: { flex: 1 },
  evidenceRow: { flexDirection: "row", gap: 10 }, evidenceButton: { flex: 1, borderWidth: 1, borderColor: line, borderRadius: 10, padding: 13, alignItems: "center", backgroundColor: "white" }, evidenceActive: { backgroundColor: "#E9F5EF", borderColor: "#267057" }, evidenceText: { color: navy, fontWeight: "800", textAlign: "center" }, photoPreview: { width: "100%", height: 220, borderRadius: 12 }, confirmedLine: { backgroundColor: "#E9F5EF", color: "#205E49", fontWeight: "800", padding: 11, borderRadius: 8 },
  totalRow: { borderTopWidth: 1, borderColor: line, paddingTop: 14, flexDirection: "row", justifyContent: "space-between" }, totalLabel: { color: muted, fontWeight: "700" }, total: { color: navy, fontSize: 18, fontWeight: "900" }, empty: { padding: 30, backgroundColor: "#E9EEE8", borderRadius: 12, alignItems: "center" }, dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#C84D3A" }, dotConfirmed: { backgroundColor: "#267057" }, dotPending: { backgroundColor: gold }, profileLine: { color: navy, fontWeight: "700", borderTopWidth: 1, borderColor: line, paddingTop: 12 }, locationQueue: { flexDirection: "row", alignItems: "center", gap: 13, padding: 16, borderRadius: 12, backgroundColor: "#E6ECF8" }, locationCount: { color: blue, fontSize: 27, fontWeight: "900" },
  nav: { position: "absolute", left: 14, right: 14, bottom: 12, backgroundColor: navy, borderRadius: 16, flexDirection: "row", padding: 7 }, navItem: { flex: 1, alignItems: "center", paddingVertical: 11 }, navText: { color: "#9FAABD", fontSize: 11, fontWeight: "800" }, navActive: { color: gold },
});
