import "../global.css";

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import {
  distanceMeters,
  hasRequiredVisitEvidence,
  MAX_PLACE_MARK_ACCURACY_METERS,
  mergeRefreshedVisits,
  parseTerritoryBoundary,
  pointInAnyTerritory,
  retryDelayMs,
  type TerritoryBoundary,
} from "@fieldops/domain";
import {
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
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
  clearRejectedLocationPoints,
  flushLocationQueue,
  locationQueueCount,
  locationQueueStats,
  queueLocationObjects,
} from "../lib/background-location";
import { fetchWithTimeout } from "../lib/network";

type Screen = "today" | "route" | "new_visit" | "visit" | "order" | "sync" | "profile";
type VisitStatus = "planned" | "active" | "completed";
type PlaceApprovalStatus = "not_applicable" | "pending_review" | "approved" | "rejected";
type WorkState = "not_started" | "active" | "finished";
type Session = { token: string; expiresAt: string; employee: { id: string; name: string } };
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
  employeeId: string;
  label: string;
  state: "pending" | "syncing" | "failed" | "confirmed";
  createdAt: string;
  attempts: number;
  error?: string;
  errorKind?: "connection" | "auth" | "validation" | "server";
  httpStatus?: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
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
  placeApprovalStatus?: PlaceApprovalStatus;
  approvedOutletId?: string;
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
type ServerActivity = {
  id: string;
  entityId: string;
  kind: "visit" | "order" | "work" | "place";
  title: string;
  detail: string;
  status: "recorded" | "pending_review" | "approved" | "rejected";
  occurredAt: string;
  amount?: number;
};
type PersistedState = {
  session: Session | null;
  workState: WorkState;
  outlets: Outlet[];
  queue: QueueItem[];
  activeVisit: ActiveVisit | null;
  territoryPolicy: TerritoryPolicy;
  contextDate: string;
  serverActivity: ServerActivity[];
  lastSyncAt: string;
};

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
export const STORAGE_KEY = "fieldops-production-state-v3";
const OUTBOX_STORAGE_KEY = "fieldops-production-outbox-v1";
const RECOVERY_EMPLOYEE_STORAGE_KEY = "fieldops-recovery-employee-v1";
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const GEOFENCE_METERS = 70;
const GPS_FIX_TIMEOUT_MS = 18_000;
const emptyPermissions: PermissionState = {
  foreground: false,
  camera: false,
  microphone: false,
  services: false,
};
const unrestrictedTerritoryPolicy: TerritoryPolicy = { mode: "unrestricted", assignedCount: 0, territories: [] };

class RequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "RequestError";
  }
}

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

function trimQueue(items: QueueItem[]) {
  if (items.length <= 120) return items;
  let confirmedToRemove = items.length - 120;
  return items.filter((item) => {
    if (confirmedToRemove > 0 && item.state === "confirmed") {
      confirmedToRemove -= 1;
      return false;
    }
    return true;
  });
}

function scopeLegacyQueue(items: QueueItem[], employeeId: string) {
  return items.map((item) => ({
    ...item,
    employeeId: typeof item.employeeId === "string" && item.employeeId ? item.employeeId : employeeId,
  }));
}

function parseDurableQueue(saved: string | null, fallback: QueueItem[], activeVisit: unknown) {
  if (!saved) return migratePersistedVisits(fallback, activeVisit);
  try {
    const value = JSON.parse(saved) as unknown;
    if (!Array.isArray(value)) return migratePersistedVisits(fallback, activeVisit);
    return migratePersistedVisits(
      value.filter((item): item is QueueItem => Boolean(item && typeof item === "object")),
      activeVisit,
    );
  } catch {
    return migratePersistedVisits(fallback, activeVisit);
  }
}

function visitSubmissionOutletId(operation: OfflineOperation | undefined) {
  if (operation?.type !== "visit_submit") return "";
  return operation.fields.outletId || operation.fields.visitId;
}

function hasQueuedVisitSubmission(queue: QueueItem[], visitId: string) {
  return queue.some((item) => (
    item.operation?.type === "visit_submit" && item.operation.fields.visitId === visitId
  ));
}

function applyConfirmedVisitStatuses(outlets: Outlet[], queue: QueueItem[]) {
  const confirmedOutletIds = new Set(queue.flatMap((item) => {
    if (item.state !== "confirmed") return [];
    const outletId = visitSubmissionOutletId(item.operation);
    return outletId ? [outletId] : [];
  }));
  return outlets.map((outlet) => confirmedOutletIds.has(outlet.id) ? { ...outlet, status: "completed" as const } : outlet);
}

let outboxWriteMutation: Promise<void> = Promise.resolve();

async function persistDurableQueue(queue: QueueItem[]) {
  const operation = outboxWriteMutation.then(() => AsyncStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(queue)));
  outboxWriteMutation = operation.catch(() => undefined);
  await operation;
}

function parseState(saved: string): PersistedState | null {
  try {
    const value = JSON.parse(saved) as Partial<PersistedState>;
    if (!value || !Array.isArray(value.outlets) || !Array.isArray(value.queue)) return null;
    const rawSession = value.session as Partial<Session> | null | undefined;
    const rawEmployee = rawSession?.employee as Partial<Session["employee"]> | null | undefined;
    const session = (
      typeof rawSession?.token === "string"
      && typeof rawSession?.expiresAt === "string"
      && typeof rawEmployee?.id === "string"
      && typeof rawEmployee?.name === "string"
    ) ? {
      token: rawSession.token,
      expiresAt: rawSession.expiresAt,
      employee: { id: rawEmployee.id, name: rawEmployee.name },
    } : null;
    const persisted = migratePersistedVisits(
      value.queue.filter((item) => item?.state === "confirmed" || Boolean(item?.operation)),
      value.activeVisit,
    );
    return {
      session,
      workState: value.workState ?? "not_started",
      outlets: value.outlets.map((outlet) => ({
        ...outlet,
        kind: outlet.kind === "self" ? "self" : "assigned",
        workDate: outlet.workDate || pakistanWorkDate(),
        ...(outlet.kind === "self" ? {
          placeApprovalStatus: (["approved", "rejected", "pending_review"] as const).includes(outlet.placeApprovalStatus as "approved" | "rejected" | "pending_review")
            ? outlet.placeApprovalStatus
            : "pending_review",
        } : {}),
      })),
      queue: persisted.queue,
      activeVisit: persisted.activeVisit,
      territoryPolicy: normalizeTerritoryPolicy(value.territoryPolicy),
      contextDate: typeof value.contextDate === "string" ? value.contextDate : "",
      serverActivity: Array.isArray(value.serverActivity) ? value.serverActivity : [],
      lastSyncAt: typeof value.lastSyncAt === "string" ? value.lastSyncAt : "",
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
  if (position === "unrestricted") return "Location ready. You can visit customers anywhere while your work session is active.";
  if (position === "checking") return "Finding your location. Keep the phone still for a moment.";
  if (position === "inside") return `Location ready. You’re inside ${names || "your work area"}.`;
  if (position === "boundary_missing") {
    return "Your manager needs to finish the work-area map before visits can start.";
  }
  return `You’re outside ${names || "your work area"}. Move inside the assigned area, then check again.`;
}

type JsonRequestConfig = {
  token?: string;
  timeoutMessage?: string;
};

async function jsonRequest(
  path: string,
  options: RequestInit = {},
  config: JsonRequestConfig = {},
) {
  const { token, timeoutMessage } = config;
  const response = await fetchWithTimeout(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  }, { timeoutMessage });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(body.error || "The FieldOPS server could not complete this request.", response.status);
  return body;
}

async function revokeMobileSession(session: Session) {
  await fetchWithTimeout(`${API_BASE}/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
  }, {
    timeoutMs: 3_000,
    timeoutMessage: "Session revocation timed out.",
  }).catch(() => undefined);
}

async function withGpsTimeout<T>(operation: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Location is taking too long. Move into an open area, then check again.")), GPS_FIX_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function preserveEvidence(uri: string, extension: string) {
  const directory = new Directory(Paths.document, "visit-evidence");
  directory.create({ intermediates: true, idempotent: true });
  const target = new File(directory, `${operationId("evidence")}.${extension}`);
  await new File(uri).copy(target);
  const exists = target.exists;
  const size = exists ? target.size : null;
  if (!exists || size === null || size <= 0 || size > MAX_EVIDENCE_BYTES) {
    if (target.exists) target.delete();
    if (size !== null && size > MAX_EVIDENCE_BYTES) {
      throw new Error("Evidence must be 20 MB or smaller.");
    }
    throw new Error("The evidence file was empty or could not be saved. Please capture it again.");
  }
  return target.uri;
}

function validateStoredEvidence(attachment: EvidenceAttachment) {
  const file = new File(attachment.uri);
  if (!file.exists) throw new Error(`${attachment.name} is no longer available. Capture the evidence again.`);
  const size = file.size;
  if (size === null || size <= 0) throw new Error(`${attachment.name} is empty. Capture the evidence again.`);
  if (size > MAX_EVIDENCE_BYTES) throw new Error(`${attachment.name} must be 20 MB or smaller.`);
}

function deleteLocalEvidence(operation: OfflineOperation) {
  if (operation.type === "json") return;
  for (const attachment of [operation.photo, operation.audio]) {
    deleteStoredAttachment(attachment);
  }
}

function deleteStoredAttachment(attachment?: EvidenceAttachment) {
  if (!attachment) return;
  try {
    const file = new File(attachment.uri);
    if (file.exists) file.delete();
  } catch {
    // Best effort: confirmed or discarded evidence can be reclaimed later by
    // the operating system if the file is temporarily unavailable.
  }
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
  const audioRecorderState = useAudioRecorderState(audioRecorder, 250);
  const [recording, setRecording] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState>(emptyPermissions);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [locationPending, setLocationPending] = useState(0);
  const [locationRejected, setLocationRejected] = useState(0);
  const [locationSyncError, setLocationSyncError] = useState("");
  const [recoveryEmployeeId, setRecoveryEmployeeId] = useState("");
  const [territoryPolicy, setTerritoryPolicy] = useState<TerritoryPolicy>(unrestrictedTerritoryPolicy);
  const [contextDate, setContextDate] = useState("");
  const [territoryPosition, setTerritoryPosition] = useState<TerritoryPosition>("checking");
  const [locationChecking, setLocationChecking] = useState(false);
  const [lastLocationCheck, setLastLocationCheck] = useState<{ accuracy: number; checkedAt: string } | null>(null);
  const [networkOnline, setNetworkOnline] = useState<boolean | null>(null);
  const [serverActivity, setServerActivity] = useState<ServerActivity[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState("");
  const queueRef = useRef<QueueItem[]>([]);
  const sessionRef = useRef<Session | null>(null);
  const recoveryEmployeeIdRef = useRef("");
  const sessionEpochRef = useRef(0);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncRequestedRef = useRef(false);
  const syncForceRequestedRef = useRef(false);
  const visitSubmittingRef = useRef(false);
  const permissionPrompted = useRef(false);
  const heartbeatRunningRef = useRef(false);
  const lastHeartbeatAtRef = useRef(0);

  const selected = outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];
  const assignedOutlets = outlets.filter((outlet) => outlet.kind === "assigned");
  const selfVisits = outlets.filter((outlet) => outlet.kind === "self");
  const completed = assignedOutlets.filter((outlet) => outlet.status === "completed").length;
  const employeeQueue = useMemo(
    () => session ? queue.filter((item) => item.employeeId === session.employee.id) : [],
    [queue, session?.employee.id],
  );
  const pending = employeeQueue.filter((item) => item.state === "failed" || item.state === "pending" || item.state === "syncing").length + locationPending + locationRejected;
  const pendingVisitOutletIds = useMemo(() => new Set(employeeQueue.flatMap((item) => {
    if (item.state === "confirmed") return [];
    const outletId = visitSubmissionOutletId(item.operation);
    return outletId ? [outletId] : [];
  })), [employeeQueue]);
  const nextOutlet = useMemo(
    () => outlets.find((outlet) => (
      outlet.kind === "assigned" && outlet.status !== "completed" && !pendingVisitOutletIds.has(outlet.id)
    )),
    [outlets, pendingVisitOutletIds],
  );
  const permissionReady = permissionState.foreground && permissionState.services;
  const trackingReady = permissionState.foreground && permissionState.services;
  const workActuallyRunning = workState === "active" && trackingReady;
  const territoryPolicyReady = contextDate === pakistanWorkDate();
  const fieldActionsAllowed = territoryPolicyReady && (territoryPosition === "unrestricted" || territoryPosition === "inside");
  const territoryMessage = territoryPolicyReady
    ? territoryCopy(territoryPolicy, territoryPosition)
    : "Today’s work access has not downloaded yet. Tap Update while online before starting a visit or order.";

  async function setQueueDurably(update: (items: QueueItem[]) => QueueItem[]) {
    const next = trimQueue(update(queueRef.current));
    queueRef.current = next;
    setQueue(next);
    await persistDurableQueue(next);
    return next;
  }

  function sessionIsCurrent(expected: Session, epoch: number) {
    return sessionEpochRef.current === epoch && sessionRef.current?.token === expected.token;
  }

  function updateTerritoryPosition(latitude: number, longitude: number, policy = territoryPolicy) {
    const position = positionForPoint(policy, latitude, longitude);
    setTerritoryPosition(position);
    return position;
  }

  function requireTerritory(latitude: number, longitude: number) {
    if (!territoryPolicyReady) {
      throw new Error("Update today’s work access before recording field work. Your saved uploads remain safe while offline.");
    }
    const position = updateTerritoryPosition(latitude, longitude);
    if (position !== "inside" && position !== "unrestricted") {
      throw new Error(territoryCopy(territoryPolicy, position));
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(OUTBOX_STORAGE_KEY),
      AsyncStorage.getItem(RECOVERY_EMPLOYEE_STORAGE_KEY),
    ]).then(([saved, savedOutbox, savedRecoveryEmployeeId]) => {
      if (cancelled) return;
      const value = saved ? parseState(saved) : null;
      if (!value) {
        const parsed = parseDurableQueue(savedOutbox, [], null);
        const unconfirmedOwners = [...new Set(parsed.queue
          .filter((item) => item.state !== "confirmed" && item.employeeId)
          .map((item) => item.employeeId))];
        const recoveryOwner = savedRecoveryEmployeeId || (unconfirmedOwners.length === 1 ? unconfirmedOwners[0]! : "");
        const recoveredQueue = scopeLegacyQueue(parsed.queue, recoveryOwner);
        queueRef.current = recoveredQueue;
        setQueue(recoveredQueue);
        if (recoveryOwner) {
          recoveryEmployeeIdRef.current = recoveryOwner;
          setRecoveryEmployeeId(recoveryOwner);
          AsyncStorage.setItem(RECOVERY_EMPLOYEE_STORAGE_KEY, recoveryOwner).catch(() => undefined);
        }
        persistDurableQueue(recoveredQueue).catch(() => undefined);
        return;
      }
      const legacyOwnerId = savedRecoveryEmployeeId || value.session?.employee.id || "";
      const parsed = parseDurableQueue(savedOutbox, value.queue, value.activeVisit);
      const persisted = { ...parsed, queue: scopeLegacyQueue(parsed.queue, legacyOwnerId) };
      const ownerQueue = legacyOwnerId
        ? persisted.queue.filter((item) => item.employeeId === legacyOwnerId)
        : [];
      const restoredOutlets = applyConfirmedVisitStatuses(value.outlets, ownerQueue);
      const restoredActiveVisit = persisted.activeVisit
        && hasQueuedVisitSubmission(ownerQueue, persisted.activeVisit.id)
        ? null
        : persisted.activeVisit;
      const restoredSession = savedRecoveryEmployeeId ? null : value.session;
      recoveryEmployeeIdRef.current = savedRecoveryEmployeeId ?? "";
      setRecoveryEmployeeId(savedRecoveryEmployeeId ?? "");
      sessionRef.current = restoredSession;
      setSession(restoredSession);
      setWorkState(value.workState);
      setOutlets(restoredOutlets);
      setQueue(persisted.queue);
      queueRef.current = persisted.queue;
      setActiveVisit(restoredActiveVisit);
      setTerritoryPolicy(value.territoryPolicy);
      setContextDate(value.contextDate);
      setServerActivity(value.serverActivity);
      setLastSyncAt(value.lastSyncAt);
      setTerritoryPosition(value.territoryPolicy.mode === "restricted" ? "checking" : "unrestricted");
      if (restoredActiveVisit) setSelectedId(restoredActiveVisit.outletId);
      else if (restoredOutlets[0]) setSelectedId(restoredOutlets[0].id);
      persistDurableQueue(persisted.queue).catch(() => undefined);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => { cancelled = true; };
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
      contextDate,
      serverActivity,
      lastSyncAt,
    })).catch(() => undefined);
  }, [activeVisit, contextDate, hydrated, lastSyncAt, outlets, queue, serverActivity, session, territoryPolicy, workState]);

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
    if (!hydrated || !session || !permissionChecked || !permissionReady || !territoryPolicyReady || territoryPosition !== "checking") return;
    checkMyLocation(false, territoryPolicy).catch(() => undefined);
  }, [contextDate, hydrated, permissionChecked, permissionReady, session?.token, territoryPolicy, territoryPosition]);

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
      Promise.all([
        syncOperations(),
        flushLocationQueue(session.employee.id, session.token),
      ]).then(() => refreshLocationCount()).catch(() => undefined);
    }, 15_000);
    const appSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshPermissions(false)
          .then((permissions) => captureLiveHeartbeat(true, permissions))
          .catch(() => undefined);
        Promise.all([
          syncOperations(),
          flushLocationQueue(session.employee.id, session.token),
        ]).then(() => refreshLocationCount()).catch(() => undefined);
        refreshContext(false).catch(() => undefined);
      }
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      setNetworkOnline(online);
      if (online) {
        Promise.all([
          syncOperations({ force: true }),
          flushLocationQueue(session.employee.id, session.token),
        ]).then(() => refreshLocationCount()).catch(() => undefined);
        refreshPermissions(false)
          .then((permissions) => captureLiveHeartbeat(true, permissions))
          .catch(() => undefined);
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
    const employeeId = sessionRef.current?.employee.id;
    const stats = await locationQueueStats(employeeId);
    setLocationPending(stats.pending);
    setLocationRejected(stats.rejected);
    setLocationSyncError(stats.error);
  }

  function removeRejectedRoutePoints() {
    const employeeId = sessionRef.current?.employee.id;
    if (!employeeId || locationRejected === 0) return;
    Alert.alert(
      "Remove invalid route points?",
      `${locationRejected} ${locationRejected === 1 ? "point was" : "points were"} rejected by the server and cannot be uploaded. Confirm to remove only those invalid points from this phone.`,
      [
        { text: "Keep", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => {
          clearRejectedLocationPoints(employeeId).then(() => refreshLocationCount()).catch(() => {
            Alert.alert("Could not remove points", "Try again from Activity.");
          });
        } },
      ],
    );
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
    } catch (error) {
      Alert.alert("Location setup did not finish", error instanceof Error ? error.message : "Open phone settings and allow location for FieldOPS.");
    } finally {
      setPermissionBusy(false);
      setPermissionChecked(true);
    }
  }

  async function executeOperation(operation: OfflineOperation, authenticatedSession: Session) {
    if (operation.type === "json") {
      const confirmation = await jsonRequest(operation.path, { method: "POST", body: JSON.stringify(operation.body) }, { token: authenticatedSession.token });
      if (confirmation?.ok !== true) {
        throw new RequestError("The server did not confirm this saved work. FieldOPS will keep it and retry.", 502);
      }
      return confirmation;
    }
    validateStoredEvidence(operation.photo);
    validateStoredEvidence(operation.audio);
    const form = new FormData();
    for (const [key, value] of Object.entries(operation.fields)) form.append(key, value);
    form.append("photo", operation.photo as never);
    form.append("audio", operation.audio as never);
    const response = await fetchWithTimeout(`${API_BASE}${operation.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${authenticatedSession.token}` },
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(body.error || "Visit evidence could not be uploaded.", response.status);
    if (body.ok !== true) {
      throw new RequestError("The server did not confirm the visit evidence. FieldOPS will keep it and retry.", 502);
    }
    return body;
  }

  function syncOperations(options: { force?: boolean; onlyId?: string } = {}): Promise<void> {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession) return Promise.resolve();
    const sessionEpoch = sessionEpochRef.current;
    if (syncPromiseRef.current) {
      syncRequestedRef.current = true;
      if (options.force) syncForceRequestedRef.current = true;
      return syncPromiseRef.current;
    }
    const operation = (async () => {
      let force = Boolean(options.force);
      let onlyId = options.onlyId;
      let confirmedAny = false;
      do {
        syncRequestedRef.current = false;
        syncForceRequestedRef.current = false;
        const now = Date.now();
        const candidates = [...queueRef.current]
          .filter((item) => (
            item.employeeId === authenticatedSession.employee.id
            && item.operation
            && item.state !== "confirmed"
            && (!onlyId || item.id === onlyId)
            && (force || !item.nextAttemptAt || new Date(item.nextAttemptAt).valueOf() <= now)
          ))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        const processItem = async (item: QueueItem) => {
          if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return "auth" as const;
          const lastAttemptAt = new Date().toISOString();
          await setQueueDurably((items) => items.map((entry) => entry.id === item.id ? {
            ...entry,
            state: "syncing",
            lastAttemptAt,
            error: undefined,
            errorKind: undefined,
            httpStatus: undefined,
          } : entry));
          try {
            await executeOperation(item.operation!, authenticatedSession);
            if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return "auth" as const;
            await setQueueDurably((items) => items.map((entry) => entry.id === item.id
              ? { ...entry, state: "confirmed", error: undefined, errorKind: undefined, httpStatus: undefined, nextAttemptAt: undefined }
              : entry));
            confirmedAny = true;
            setLastSyncAt(new Date().toISOString());
            if (item.operation?.type === "visit_submit") {
              const outletId = item.operation.fields.outletId || item.operation.fields.visitId;
              setOutlets((items) => items.map((outlet) => outlet.id === outletId ? {
                ...outlet,
                status: "completed",
                ...(outlet.kind === "self" ? { placeApprovalStatus: "pending_review" as const } : {}),
              } : outlet));
              deleteLocalEvidence(item.operation);
            }
            return "confirmed" as const;
          } catch (error) {
            if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return "auth" as const;
            const status = error instanceof RequestError ? error.status : 0;
            const errorKind: QueueItem["errorKind"] = status === 401
              ? "auth"
              : [400, 403, 404, 409, 422].includes(status)
                ? "validation"
                : status >= 500
                  ? "server"
                  : "connection";
            await setQueueDurably((items) => items.map((entry) => {
              if (entry.id !== item.id) return entry;
              const attempts = entry.attempts + 1;
              const delay = errorKind === "validation" || errorKind === "auth"
                ? 5 * 60_000
                : retryDelayMs(attempts);
              return {
                ...entry,
                state: "failed",
                attempts,
                errorKind,
                ...(status ? { httpStatus: status } : {}),
                lastAttemptAt,
                nextAttemptAt: new Date(Date.now() + delay).toISOString(),
                error: error instanceof Error ? error.message : "Connection interrupted. FieldOPS will retry.",
              };
            }));
            return errorKind;
          }
        };

        const attendance = candidates.filter((item) => item.operation?.type === "json" && item.operation.path === "/attendance");
        let attendanceBlocked = false;
        for (const item of attendance) {
          const result = await processItem(item);
          if (result === "auth" || result === "connection" || result === "server") {
            attendanceBlocked = true;
            break;
          }
        }
        if (!attendanceBlocked) {
          const remaining = candidates.filter((item) => !attendance.includes(item));
          let cursor = 0;
          let uploadsBlocked = false;
          const worker = async () => {
            while (cursor < remaining.length && !uploadsBlocked) {
              const item = remaining[cursor];
              cursor += 1;
              if (item) {
                const result = await processItem(item);
                if (result === "auth" || result === "connection" || result === "server") uploadsBlocked = true;
              }
            }
          };
          await Promise.all([worker(), worker()]);
        }
        force = syncForceRequestedRef.current;
        onlyId = undefined;
      } while (syncRequestedRef.current && sessionIsCurrent(authenticatedSession, sessionEpoch));
      if (confirmedAny && sessionIsCurrent(authenticatedSession, sessionEpoch)) {
        await refreshContext(false).catch(() => undefined);
      }
    })();
    syncPromiseRef.current = operation;
    return operation.finally(() => {
      if (syncPromiseRef.current === operation) syncPromiseRef.current = null;
    });
  }

  async function retryQueueItem(id: string) {
    await setQueueDurably((items) => items.map((item) => item.id === id ? {
      ...item,
      state: "pending",
      nextAttemptAt: undefined,
      error: undefined,
      errorKind: undefined,
      httpStatus: undefined,
    } : item));
    await syncOperations({ force: true, onlyId: id });
  }

  async function enqueue(label: string, operation: OfflineOperation) {
    const employeeId = sessionRef.current?.employee.id;
    if (!employeeId) throw new Error("Sign in again before saving this work.");
    const item: QueueItem = {
      id: operationId("event"),
      employeeId,
      label,
      state: "pending",
      createdAt: new Date().toISOString(),
      attempts: 0,
      operation,
    };
    await setQueueDurably((items) => [...items, item]);
    setTimeout(() => syncOperations().catch(() => undefined), 0);
    return item;
  }

  async function refreshContext(showMessage = true) {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession) return;
    const sessionEpoch = sessionEpochRef.current;
    setRefreshing(true);
    try {
      const context = await jsonRequest("/context", {}, { token: authenticatedSession.token });
      if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
      const today = String(context.date ?? pakistanWorkDate());
      const nextPolicy = normalizeTerritoryPolicy(context.territoryPolicy);
      setOutlets((current) => mergeRefreshedVisits(context.route as Outlet[], current, today));
      setServerActivity(Array.isArray(context.recentActivity) ? context.recentActivity as ServerActivity[] : []);
      setLastSyncAt(new Date().toISOString());
      setTerritoryPolicy(nextPolicy);
      setContextDate(today);
      setTerritoryPosition(nextPolicy.mode === "restricted" ? "checking" : "unrestricted");
      const hasPendingAttendance = queueRef.current.some((item) => (
        item.employeeId === authenticatedSession.employee.id
        &&
        item.operation?.type === "json"
        && item.operation.path === "/attendance"
        && item.state !== "confirmed"
      ));
      if (!hasPendingAttendance) setWorkState(context.workState ?? (context.shiftActive ? "active" : "not_started"));
      setSelectedId((current) => current || String(context.route[0]?.id ?? ""));
      checkMyLocation(false, nextPolicy).catch(() => undefined);
      if (showMessage) {
        const assignedCount = (context.route as Outlet[]).filter((outlet) => outlet.kind !== "self").length;
        Alert.alert("Today updated", `${assignedCount} assigned ${assignedCount === 1 ? "visit" : "visits"} and your latest activity are ready.`);
      }
    } catch (error) {
      if (showMessage && sessionIsCurrent(authenticatedSession, sessionEpoch)) {
        Alert.alert("Working offline", error instanceof Error ? error.message : "Could not refresh assigned visits.");
      }
    } finally {
      if (sessionIsCurrent(authenticatedSession, sessionEpoch)) setRefreshing(false);
    }
  }

  async function signIn(email: string, password: string) {
    const result = await jsonRequest("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }, {
      timeoutMessage: "Sign in is taking longer than expected. Check your internet connection and try again.",
    }) as Session;
    const recoveryOwner = recoveryEmployeeIdRef.current;
    if (recoveryOwner && result.employee.id !== recoveryOwner) {
      throw new Error("This phone has unsynced work for another employee. Sign in with the same account to recover and upload it first.");
    }
    if (recoveryOwner) {
      // Persist the replacement session before removing the recovery marker.
      // If the app closes between these writes, it will require the same
      // employee to authenticate again instead of exposing the saved draft.
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
        session: result,
        workState,
        outlets,
        queue: queueRef.current,
        activeVisit,
        territoryPolicy,
        contextDate,
        serverActivity,
        lastSyncAt,
      } satisfies PersistedState));
      await AsyncStorage.removeItem(RECOVERY_EMPLOYEE_STORAGE_KEY);
      recoveryEmployeeIdRef.current = "";
      setRecoveryEmployeeId("");
    }
    if (!recoveryOwner) {
      setContextDate("");
      setTerritoryPolicy(unrestrictedTerritoryPolicy);
      setTerritoryPosition("checking");
    }
    sessionEpochRef.current += 1;
    sessionRef.current = result;
    setSession(result);
    permissionPrompted.current = false;
    setScreen("today");
  }

  async function getGpsFix(accuracy = Location.Accuracy.High) {
    const permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted) throw new Error("Location access is off. Allow location in phone settings, then try again.");
    if (!await Location.hasServicesEnabledAsync()) throw new Error("Phone location is off. Turn on Location Services, then try again.");
    return withGpsTimeout(Location.getCurrentPositionAsync({ accuracy }));
  }

  async function checkMyLocation(showError = true, policy = territoryPolicy) {
    setLocationChecking(true);
    if (policy.mode === "restricted") setTerritoryPosition("checking");
    try {
      const point = await getGpsFix(Location.Accuracy.Balanced);
      updateTerritoryPosition(point.coords.latitude, point.coords.longitude, policy);
      setLastLocationCheck({ accuracy: Math.round(point.coords.accuracy ?? 0), checkedAt: new Date().toISOString() });
      return point;
    } catch (error) {
      await refreshPermissions(false).catch(() => undefined);
      if (showError) {
        Alert.alert("Location not ready", error instanceof Error ? error.message : "Check phone location and try again.", [
          { text: "Close", style: "cancel" },
          { text: "Open settings", onPress: () => Linking.openSettings() },
        ]);
      }
      throw error;
    } finally {
      setLocationChecking(false);
    }
  }

  async function gps(accuracy = Location.Accuracy.High) {
    const point = await getGpsFix(accuracy);
    updateTerritoryPosition(point.coords.latitude, point.coords.longitude);
    setLastLocationCheck({ accuracy: Math.round(point.coords.accuracy ?? 0), checkedAt: new Date().toISOString() });
    return point;
  }

  async function captureLiveHeartbeat(force = false, permissions: PermissionState = permissionState) {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession || workState !== "active") return;
    const sessionEpoch = sessionEpochRef.current;
    if (!permissions.foreground || !permissions.services) return;
    if (heartbeatRunningRef.current) return;
    if (!force && Date.now() - lastHeartbeatAtRef.current < 45_000) {
      await flushLocationQueue(authenticatedSession.employee.id, authenticatedSession.token);
      if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
      await refreshLocationCount();
      return;
    }

    heartbeatRunningRef.current = true;
    try {
      const point = await gps(Location.Accuracy.High);
      if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
      await queueLocationObjects(authenticatedSession.employee.id, [point], "foreground");
      lastHeartbeatAtRef.current = Date.now();
      await flushLocationQueue(authenticatedSession.employee.id, authenticatedSession.token);
      if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
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
      await queueLocationObjects(session.employee.id, [point], "foreground");
      await enqueue("Start work", { type: "json", path: "/attendance", body: {
        action: "check_in",
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("start"),
      } });
      flushLocationQueue(session.employee.id, session.token).then(() => refreshLocationCount()).catch(() => undefined);
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
      await queueLocationObjects(session.employee.id, [point], "foreground");
      await enqueue("Finish today’s work", { type: "json", path: "/attendance", body: {
        action: "check_out",
        latitude: point.coords.latitude,
        longitude: point.coords.longitude,
        accuracy: point.coords.accuracy ?? 0,
        capturedAt,
        idempotencyKey: operationId("finish"),
      } });
      setWorkState("finished");
      await flushLocationQueue(session.employee.id, session.token);
      await refreshLocationCount();
    } catch (error) {
      Alert.alert("GPS required to finish", error instanceof Error ? error.message : "Turn on GPS and try again.");
    }
  }

  async function startVisit(outlet: Outlet) {
    if (!session) return;
    if (pendingVisitOutletIds.has(outlet.id)) {
      Alert.alert("Visit upload is pending", "This visit is safely queued and will become completed after server confirmation. Open Activity to retry it now.");
      return;
    }
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
      const markAccuracy = point.coords.accuracy;
      if (typeof markAccuracy !== "number" || !Number.isFinite(markAccuracy) || markAccuracy < 0 || markAccuracy > MAX_PLACE_MARK_ACCURACY_METERS) {
        const accuracyLabel = typeof markAccuracy === "number" && Number.isFinite(markAccuracy) ? `${Math.round(markAccuracy)} m` : "an unknown distance";
        throw new Error(`The GPS signal is weak right now (about ±${accuracyLabel}). Step near the shop entrance or into an open area, wait for the accuracy number to improve, then mark again.`);
      }
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
        placeApprovalStatus: "pending_review",
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
          checkInAccuracy: String(markAccuracy),
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
    const previousPhoto = activeVisit?.photo;
    try {
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
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) throw new Error("The camera did not return a photo. Please try again.");
      const uri = await preserveEvidence(asset.uri, "jpg");
      setActiveVisit((current) => current ? { ...current, photo: {
        uri,
        name: `visit-${current.id}.jpg`,
        type: "image/jpeg",
      } } : current);
      if (previousPhoto?.uri !== uri) deleteStoredAttachment(previousPhoto);
    } catch (error) {
      Alert.alert("Photo not saved", error instanceof Error ? error.message : "Could not save this photo. Please try again.");
    }
  }

  async function toggleRecording() {
    if (recording) {
      const previousAudio = activeVisit?.audio;
      try {
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        if (!uri) throw new Error("The recorder did not return an audio file. Please record the note again.");
        const preservedUri = await preserveEvidence(uri, "m4a");
        setActiveVisit((current) => current ? { ...current, audio: {
          uri: preservedUri,
          name: `visit-${current.id}.m4a`,
          type: "audio/m4a",
        } } : current);
        if (previousAudio?.uri !== preservedUri) deleteStoredAttachment(previousAudio);
      } catch (error) {
        try { await audioRecorder.stop(); } catch { /* Already stopped or unavailable. */ }
        Alert.alert("Audio not saved", error instanceof Error ? error.message : "Could not save this audio note. Please try again.");
      } finally {
        setRecording(false);
        try { await setAudioModeAsync({ allowsRecording: false }); } catch { /* Reset is best effort after stopping. */ }
      }
      return;
    }
    try {
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
    } catch (error) {
      try { await audioRecorder.stop(); } catch { /* The recorder may not have started. */ }
      try { await setAudioModeAsync({ allowsRecording: false }); } catch { /* Reset is best effort. */ }
      setRecording(false);
      Alert.alert("Recording did not start", error instanceof Error ? error.message : "Could not start the microphone. Please try again.");
    }
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
      validateStoredEvidence(activeVisit.photo);
      validateStoredEvidence(activeVisit.audio);
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
      await enqueue(`${selected.name} · ${selected.kind === "self" ? "send place report" : "complete visit"}`, {
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
      setActiveVisit(null);
      setScreen("route");
      Alert.alert(
        selected.kind === "self" ? "Place report saved" : "Visit saved",
        selected.kind === "self"
          ? "The marked point, photo, and voice report are safe. After upload, an admin will review the name and add it as a permanent place."
          : "The photo, voice report, and GPS are safe. The visit completes after server confirmation.",
      );
    } catch (error) {
      Alert.alert("Visit not finished", error instanceof Error ? error.message : "Turn on GPS and try again.");
    } finally {
      visitSubmittingRef.current = false;
    }
  }

  function discardActiveVisit() {
    if (!activeVisit || !selected || activeVisit.outletId !== selected.id) return;
    if (recording) {
      Alert.alert("Stop the recording first", "Stop the voice recording before discarding this draft.");
      return;
    }
    Alert.alert(
      selected.kind === "self" ? "Discard this marked place?" : "Discard this visit draft?",
      "The unsent point, photo, voice report, and notes will be removed from this phone.",
      [
        { text: "Keep draft", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => {
          deleteStoredAttachment(activeVisit.photo);
          deleteStoredAttachment(activeVisit.audio);
          setActiveVisit(null);
          setOutlets((items) => selected.kind === "self"
            ? items.filter((item) => item.id !== selected.id)
            : items.map((item) => item.id === selected.id ? { ...item, status: "planned" } : item));
          setSelectedId("");
          setScreen("route");
        } },
      ],
    );
  }

  async function createOrder(order: OrderDraft) {
    if (!session) return;
    try {
      const point = await gps(Location.Accuracy.Balanced);
      requireTerritory(point.coords.latitude, point.coords.longitude);
      const capturedAt = new Date(point.timestamp).toISOString();
      await enqueue(`Order · ${order.customerName}`, { type: "json", path: "/orders", body: {
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
    await Promise.all([
      syncOperations({ force: true }),
      session ? flushLocationQueue(session.employee.id, session.token) : Promise.resolve(0),
    ]);
    await refreshLocationCount();
    await refreshContext(false);
  }

  async function signOut() {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession) return;
    if (recording) {
      Alert.alert("Stop the recording first", "Stop and save the audio note before signing out.");
      return;
    }
    const employeeId = authenticatedSession.employee.id;
    const unconfirmed = queueRef.current.filter((item) => (
      item.employeeId === employeeId && item.state !== "confirmed"
    )).length;
    const queuedLocations = await locationQueueCount(employeeId);
    if (activeVisit || unconfirmed > 0 || queuedLocations > 0) {
      try {
        await persistDurableQueue(queueRef.current);
        await AsyncStorage.multiSet([
          [RECOVERY_EMPLOYEE_STORAGE_KEY, employeeId],
          [STORAGE_KEY, JSON.stringify({
            session: null,
            workState,
            outlets,
            queue: queueRef.current,
            activeVisit,
            territoryPolicy,
            contextDate,
            serverActivity,
            lastSyncAt,
          } satisfies PersistedState)],
        ]);
      } catch {
        Alert.alert("Could not protect saved work", "FieldOPS could not update local storage. Please try again before signing out.");
        return;
      }
      await revokeMobileSession(authenticatedSession);
      recoveryEmployeeIdRef.current = employeeId;
      setRecoveryEmployeeId(employeeId);
      sessionEpochRef.current += 1;
      sessionRef.current = null;
      syncPromiseRef.current = null;
      heartbeatRunningRef.current = false;
      setSession(null);
      setLocationPending(0);
      setLocationRejected(0);
      setLocationSyncError("");
      setNetworkOnline(null);
      setRefreshing(false);
      setScreen("today");
      Alert.alert(
        "Work kept safely",
        "Sign in again with the same account to continue this visit and upload the saved work.",
      );
      return;
    }
    try {
      await setQueueDurably(() => []);
      await AsyncStorage.removeItem(RECOVERY_EMPLOYEE_STORAGE_KEY);
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
        session: null,
        workState: "not_started",
        outlets: [],
        queue: [],
        activeVisit: null,
        territoryPolicy: unrestrictedTerritoryPolicy,
        contextDate: "",
        serverActivity: [],
        lastSyncAt: "",
      } satisfies PersistedState));
    } catch {
      Alert.alert("Could not sign out safely", "FieldOPS could not update local storage. Please try again.");
      return;
    }
    await revokeMobileSession(authenticatedSession);
    sessionEpochRef.current += 1;
    sessionRef.current = null;
    syncPromiseRef.current = null;
    heartbeatRunningRef.current = false;
    recoveryEmployeeIdRef.current = "";
    setSession(null);
    setRecoveryEmployeeId("");
    setOutlets([]);
    setSelectedId("");
    setWorkState("not_started");
    setActiveVisit(null);
    setLocationPending(0);
    setLocationRejected(0);
    setLocationSyncError("");
    setNetworkOnline(null);
    setRefreshing(false);
    setTerritoryPolicy(unrestrictedTerritoryPolicy);
    setContextDate("");
    setTerritoryPosition("checking");
    setServerActivity([]);
    setLastSyncAt("");
    setScreen("today");
  }

  if (!hydrated) {
    return <SafeAreaView className="flex-1 bg-paper" edges={["top", "bottom"]}>
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-2xl font-black text-ink">Loading FieldOPS…</Text>
      </View>
    </SafeAreaView>;
  }
  if (!session) return <Login onSubmit={signIn} recoveryRequired={Boolean(recoveryEmployeeId)} />;
  if (!permissionChecked) {
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
            screen={screen}
            pending={pending}
            refreshing={refreshing}
            onSync={() => setScreen("sync")}
            onRefresh={() => refreshContext()}
          />
          {screen !== "sync" && screen !== "profile" && <TerritoryBanner
            policy={territoryPolicy}
            policyReady={territoryPolicyReady}
            position={territoryPosition}
            message={territoryMessage}
            permissionState={permissionState}
            checking={locationChecking || (!territoryPolicyReady && refreshing)}
            lastCheck={lastLocationCheck}
            onCheck={() => {
              if (territoryPolicyReady) checkMyLocation().catch(() => undefined);
              else refreshContext().catch(() => undefined);
            }}
          />}
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
            onFixGps={() => permissionReady ? checkMyLocation().catch(() => undefined) : Linking.openSettings()}
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
            checkInAccuracy={activeVisit?.outletId === selected.id ? Number(activeVisit.checkIn?.checkInAccuracy) : undefined}
            submissionPending={pendingVisitOutletIds.has(selected.id)}
            accessAllowed={fieldActionsAllowed}
            territoryMessage={territoryMessage}
            outcome={activeVisit?.outcome ?? "Order placed"}
            setOutcome={(value) => setActiveVisit((current) => current ? { ...current, outcome: value } : current)}
            notes={activeVisit?.notes ?? ""}
            setNotes={(value) => setActiveVisit((current) => current ? { ...current, notes: value } : current)}
            photo={activeVisit?.photo}
            audio={activeVisit?.audio}
            recording={Boolean(recording)}
            recordingSeconds={Math.floor(audioRecorderState.durationMillis / 1000)}
            onStart={() => startVisit(selected)}
            onPhoto={takePhoto}
            onAudio={toggleRecording}
            onFinish={finishVisit}
            onDiscard={discardActiveVisit}
          />}
          {screen === "order" && <Order
            outlets={assignedOutlets}
            accessAllowed={fieldActionsAllowed}
            territoryMessage={territoryMessage}
            onSubmit={createOrder}
          />}
          {screen === "sync" && <SyncQueue
            queue={employeeQueue}
            locationPending={locationPending}
            locationRejected={locationRejected}
            locationSyncError={locationSyncError}
            activity={serverActivity}
            online={networkOnline}
            lastSyncAt={lastSyncAt}
            onRetry={retryEverything}
            onRetryItem={retryQueueItem}
            onClearRejectedLocations={removeRejectedRoutePoints}
            onRefresh={() => refreshContext(false)}
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
      <Nav screen={screen} pending={pending} setScreen={setScreen} />
    </View>
  </SafeAreaView>;
}

function Login({
  onSubmit,
  recoveryRequired,
}: {
  onSubmit: (email: string, password: string) => Promise<void>;
  recoveryRequired: boolean;
}) {
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
          {recoveryRequired && <View className="rounded-[9px] bg-[#FFF4D6] p-3">
            <Text className="font-bold leading-5 text-[#6B4D00]">
              Saved work is waiting on this phone. Sign in with the same employee account to recover and upload it.
            </Text>
          </View>}
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
        <Eyebrow>ONE-TIME SETUP</Eyebrow>
        <ScreenTitle>Turn on location</ScreenTitle>
        <BodyText>
          Location proves you are at the customer when you check in or mark a new place. You can still open Activity and sync saved work if location is turned off later.
        </BodyText>
        <View className="rounded-2xl border border-line bg-white px-4">
          <PermissionRow label="Allow FieldOPS location" ready={state.foreground} />
          <PermissionRow label="Phone location switched on" ready={state.services} />
          <PermissionRow label="Camera for storefront photo" ready={state.camera} later />
          <PermissionRow label="Microphone for voice report" ready={state.microphone} later />
        </View>
        <Button label={busy ? "Checking…" : "Allow location & continue"} disabled={busy} onPress={onRequest} />
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
  screen,
  pending,
  refreshing,
  onSync,
  onRefresh,
}: {
  screen: Screen;
  pending: number;
  refreshing: boolean;
  onSync: () => void;
  onRefresh: () => void;
}) {
  const section = screen === "sync" ? "Activity" : screen === "profile" ? "Profile" : "Field work";
  return <View className="flex-row items-center gap-2">
    <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
      <View className="h-11 w-11 items-center justify-center rounded-[14px] bg-ink">
        <Text className="text-xs font-black tracking-wider text-gold">YR</Text>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-black text-ink">FieldOPS</Text>
        <Text className="mt-0.5 text-[11px] font-bold text-muted" numberOfLines={1}>{section} · {new Date().toLocaleDateString("en-PK", { weekday: "short", day: "numeric", month: "short" })}</Text>
      </View>
    </View>
    <View className="flex-row gap-1.5">
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Refresh today’s assignments and territory"
        className="min-h-11 min-w-11 items-center justify-center rounded-full bg-[#E6ECF8] px-2"
        onPress={onRefresh}
      >
        <Text className="text-[11px] font-black text-field">{refreshing ? "Updating" : "Update"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open activity. ${pending} records pending`}
        className="min-h-11 min-w-11 items-center justify-center rounded-full bg-[#FFF1D0] px-2"
        onPress={onSync}
      >
        <Text className="text-[11px] font-black text-[#805C00]">{pending > 0 ? `${pending} wait` : "Saved"}</Text>
      </TouchableOpacity>
    </View>
  </View>;
}

function TerritoryBanner({
  policy,
  policyReady,
  position,
  message,
  permissionState,
  checking,
  lastCheck,
  onCheck,
}: {
  policy: TerritoryPolicy;
  policyReady: boolean;
  position: TerritoryPosition;
  message: string;
  permissionState: PermissionState;
  checking: boolean;
  lastCheck: { accuracy: number; checkedAt: string } | null;
  onCheck: () => void;
}) {
  const permissionProblem = !permissionState.foreground || !permissionState.services;
  const effectivePosition = checking ? "checking" : position;
  const allowed = policyReady && !permissionProblem && (effectivePosition === "inside" || effectivePosition === "unrestricted");
  const waiting = !policyReady || effectivePosition === "checking";
  const title = !policyReady
    ? "Update today’s work access"
    : permissionProblem
    ? !permissionState.foreground ? "Allow location to begin" : "Turn on phone location"
    : effectivePosition === "inside" || effectivePosition === "unrestricted"
      ? "You’re ready here"
      : effectivePosition === "checking"
        ? "Finding your location…"
        : effectivePosition === "boundary_missing"
          ? "Work-area map needed"
          : "Move into your work area";
  const detail = !policyReady
    ? message
    : permissionProblem
    ? !permissionState.foreground
      ? "FieldOPS needs your current location to mark visits and verify evidence. Saved uploads remain available in Activity."
      : "Turn on Location Services. Saved uploads remain available in Activity."
    : message;
  return <View
    accessibilityRole="summary"
    className={classes(
      "rounded-xl border-l-4 p-4",
      allowed ? "border-success bg-[#E9F5EF]" : waiting ? "border-gold bg-[#FFF1D0]" : "border-danger bg-[#FCEDEA]",
    )}
  >
    <View className="flex-row items-start justify-between gap-3">
      <View className="flex-1">
        <Text className={classes("text-[10px] font-black tracking-wider", allowed ? "text-success" : waiting ? "text-[#805C00]" : "text-danger")}>
          {!policyReady ? "WORK ACCESS NEEDED" : permissionProblem ? "LOCATION SETUP" : policy.mode === "unrestricted" ? "LOCATION READY" : `${policy.assignedCount} WORK AREA${policy.assignedCount === 1 ? "" : "S"}`}
        </Text>
        <Text className="mt-1 text-lg font-black text-ink">{title}</Text>
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Check my current location"
        className="min-h-12 justify-center rounded-lg border border-ink px-3"
        onPress={onCheck}
        disabled={checking}
      >
        <Text className="font-extrabold text-ink">{checking ? "Checking…" : !policyReady ? "Update" : permissionProblem ? "Fix location" : "Check again"}</Text>
      </TouchableOpacity>
    </View>
    <Text className="mt-2 leading-5 text-[#586273]">{detail}</Text>
    {lastCheck && policyReady && !permissionProblem && <Text className="mt-2 text-[11px] font-bold text-[#607063]">
      Checked {new Date(lastCheck.checkedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })} · accuracy about {lastCheck.accuracy} m
    </Text>}
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
    ? "Ready for another session"
    : running
      ? "Work in progress"
      : workState === "active"
        ? "Work stopped"
        : "Ready to start";
  const detail = workState === "active" && !trackingReady
        ? "Location is paused — saved work can still sync"
    : running
      ? "Location is ready for visits and route updates"
      : workState === "finished"
        ? "Your last session is saved. Start again whenever needed"
        : "We’ll check your location when you start";
  const actionEnabled = running && fieldActionsAllowed;
  return <>
    <View className={classes(
      "flex-row items-center justify-between gap-3 rounded-2xl border-l-[5px] bg-ink p-[18px]",
      running ? "border-l-[#52B889]" : workState === "active" ? "border-l-[#D05242]" : "border-l-[#95A0B5]",
    )}>
      <View className="flex-1">
        <Text className="text-[10px] font-black tracking-wider text-[#AAB3C5]">TODAY’S SESSION</Text>
        <Text className="mt-1 text-lg font-black text-white">{title}</Text>
        <Text className="mt-1 text-[11px] text-[#BAC4D8]">{detail}</Text>
      </View>
      {workState !== "active" && <Button label={workState === "finished" ? "Start again" : "Start work"} onPress={onStartWork} />}
      {workState === "active" && trackingReady && <Button label="Finish session" onPress={onFinishWork} />}
      {workState === "active" && !trackingReady && <Button label="Fix GPS" onPress={onFixGps} />}
    </View>

    <SectionTitle>Assigned commitments</SectionTitle>
    <View className="flex-row justify-between border-y border-line py-4">
      <Stat value={`${completed}/${total}`} label="Completed" />
      <Stat value={`${Math.max(0, total - completed)}`} label="Still assigned" />
      <Stat value={running ? "Live" : "Stopped"} label="Route tracking" />
    </View>

    {nextOutlet ? <View className="rounded-2xl bg-field p-5">
      <Text className="text-[10px] font-black tracking-wider text-[#B6C2DF]">NEXT ASSIGNED VISIT</Text>
      <Text className="mt-2.5 text-2xl font-black text-white">{nextOutlet.name}</Text>
      <Text className="mt-1.5 text-[#C2CBE0]">{nextOutlet.address}</Text>
      <View className="mt-5 flex-row flex-wrap gap-2.5">
        <Button label="Check in at this shop" disabled={!actionEnabled} onPress={onStartVisit} />
        <GhostButton label="All assigned visits" onPress={onRoute} />
      </View>
      {!fieldActionsAllowed && <Text className="mt-3 leading-5 text-[#FFF1D0]">{territoryMessage}</Text>}
      <Text className="mt-3 text-xs leading-4 text-[#C2CBE0]">Stand at the shop. FieldOPS will confirm you’re within {GEOFENCE_METERS} m.</Text>
    </View> : <EmptyState title="No assigned visits waiting" body="You can still mark a new customer place while your work session and location are ready." />}

    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Mark a new customer place"
      accessibilityState={{ disabled: !actionEnabled }}
      className={classes(
        "min-h-24 flex-row items-center justify-between rounded-[14px] border border-success bg-[#E4F2EA] p-[18px]",
        !actionEnabled && "opacity-45",
      )}
      disabled={!actionEnabled}
      onPress={onNewVisit}
    >
      <View className="flex-1">
        <Text className="text-[10px] font-black tracking-wider text-success">NEW PLACE · {selfVisitCount} MARKED TODAY</Text>
        <Text className="mt-1 text-xl font-black text-ink">Mark a customer place</Text>
        <Text className="mt-1 text-xs text-[#4F655C]">You set the point · admin approves the final name</Text>
      </View>
      <Text className="font-black text-success">Mark</Text>
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
      title="A new place takes four clear steps"
      body="Mark the spot, add a photo, record your voice sales report, then send it. An admin reviews the name before the point becomes a permanent outlet."
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
    <ScreenTitle>Places & visits</ScreenTitle>
    <BodyText>Assigned shops and new places you mark stay separate, so you always know what management planned.</BodyText>
    <Button label="Mark a new customer place" disabled={!canAddVisit} onPress={onNewVisit} />
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

    <SectionTitle>Places marked by you</SectionTitle>
    {selfVisits.length === 0
      ? <View className="rounded-[10px] border border-dashed border-line p-4"><BodyText>No new places marked today.</BodyText></View>
      : selfVisits.map((outlet) => <TouchableOpacity
        key={outlet.id}
        accessibilityRole="button"
        accessibilityLabel={`Open your visit to ${outlet.name}`}
        className="mb-2 min-h-16 flex-row items-center gap-3 rounded-xl bg-[#F0F7F3] p-3.5"
        onPress={() => onSelect(outlet.id)}
      >
        <View className="h-8 w-8 items-center justify-center rounded-full bg-success"><Text className="text-sm font-black text-white">+</Text></View>
        <View className="flex-1">
          <Text className="font-extrabold text-ink">{outlet.name}</Text>
          <Text className="mt-1 text-xs text-muted">{outlet.address}</Text>
        </View>
        <PlaceReviewStatus status={outlet.placeApprovalStatus} visitStatus={outlet.status} />
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
    <Eyebrow>NEW CUSTOMER PLACE</Eyebrow>
    <ScreenTitle>Mark where you are</ScreenTitle>
    <BodyText>
      The point is the exact location where you tap the button below. It never moves. Admin can correct the place name when approving it.
    </BodyText>
    <ProcessSteps current={1} labels={["Mark point", "Take photo", "Voice report", "Admin review"]} />
    {!enabled && <WarningNotice
      title={!running ? "Start your work session first" : "You can’t mark a place here yet"}
      body={!running ? "Start work and make sure location is ready before marking a new place." : territoryMessage}
    />}
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <InputLabel>PLACE OR SHOP NAME · REQUIRED</InputLabel>
      <TextInput
        accessibilityLabel="Place or shop name"
        className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
        value={customerName}
        onChangeText={setCustomerName}
        placeholder="Example: Al Madina Store"
        placeholderTextColor="#697184"
        autoFocus
      />
      <InputLabel>ADDRESS OR LANDMARK · OPTIONAL</InputLabel>
      <TextInput
        accessibilityLabel="Customer address or area"
        className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
        value={customerAddress}
        onChangeText={setCustomerAddress}
        placeholder="Example: Tariq Road, near the pharmacy"
        placeholderTextColor="#697184"
      />
      <Button
        label={busy ? "Marking this spot…" : "Mark this spot & start report"}
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
  checkInAccuracy,
  submissionPending,
  accessAllowed,
  territoryMessage,
  outcome,
  setOutcome,
  notes,
  setNotes,
  photo,
  audio,
  recording,
  recordingSeconds,
  onStart,
  onPhoto,
  onAudio,
  onFinish,
  onDiscard,
}: {
  outlet: Outlet;
  activeVisit: boolean;
  checkInAccuracy?: number;
  submissionPending: boolean;
  accessAllowed: boolean;
  territoryMessage: string;
  outcome: string;
  setOutcome: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  photo?: EvidenceAttachment;
  audio?: EvidenceAttachment;
  recording: boolean;
  recordingSeconds: number;
  onStart: () => void;
  onPhoto: () => void;
  onAudio: () => void;
  onFinish: () => void;
  onDiscard: () => void;
}) {
  const outcomes = ["Order placed", "Order discussed", "No order", "Shop closed", "Owner unavailable"];
  const selfCreated = outlet.kind === "self";
  const voicePlayer = useAudioPlayer(audio?.uri ?? null);
  const voiceStatus = useAudioPlayerStatus(voicePlayer);
  const statusTitle = activeVisit
    ? "Report in progress"
    : submissionPending
      ? "Waiting to upload"
      : selfCreated && outlet.placeApprovalStatus === "approved"
        ? "Approved as a permanent place"
        : selfCreated && outlet.placeApprovalStatus === "rejected"
          ? "Admin asked for a new submission"
          : selfCreated && outlet.status === "completed"
            ? "Awaiting admin review"
            : outlet.status === "completed"
              ? "Visit completed"
              : `Ready to check in within ${GEOFENCE_METERS} m`;
  return <>
    <Eyebrow>{selfCreated ? "PLACE MARKED BY YOU" : "MANAGEMENT-ASSIGNED VISIT"}</Eyebrow>
    <ScreenTitle>{outlet.name}</ScreenTitle>
    <BodyText>{outlet.address}</BodyText>
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <Eyebrow>VISIT STATUS</Eyebrow>
      <Text className="text-xl font-black text-ink">{statusTitle}</Text>
      {activeVisit && typeof checkInAccuracy === "number" && Number.isFinite(checkInAccuracy) && <Text className="text-sm font-extrabold text-success">
        GPS point locked · actual accuracy ±{Math.round(checkInAccuracy)} m
      </Text>}
      {!accessAllowed && <WarningNotice title="Visit unavailable here" body={territoryMessage} />}
      {submissionPending && <BodyText>The marked point, photo, and voice report are safe on this phone. Activity shows upload progress.</BodyText>}
      {!selfCreated && !activeVisit && !submissionPending && outlet.status !== "completed" && <Button label="Check in at this shop" disabled={!accessAllowed} onPress={onStart} />}
    </View>
    {selfCreated && !activeVisit && !submissionPending && outlet.status === "completed" && <PlaceReviewNotice outlet={outlet} />}
    {activeVisit && <>
      <ProcessSteps
        current={!photo ? 2 : !audio ? 3 : 4}
        labels={selfCreated ? ["Point marked", "Take photo", "Voice report", "Send to admin"] : ["Checked in", "Take photo", "Voice report", "Send visit"]}
      />
      <WarningNotice
        title={selfCreated ? "Finish the place report here" : "Finish this visit here"}
        body={`Stay within ${GEOFENCE_METERS} m of the starting point. Add one clear storefront photo and a short voice sales report before sending.`}
      />
      <SectionTitle>Sales outcome</SectionTitle>
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
        placeholder="Add useful details for your manager"
        placeholderTextColor="#697184"
        multiline
        textAlignVertical="top"
      />
      <View className="flex-row gap-2.5">
        <EvidenceButton label={photo ? "Retake photo" : "Take storefront photo"} active={Boolean(photo)} onPress={onPhoto} />
        <EvidenceButton label={recording ? `Stop · ${recordingSeconds}s` : audio ? "Retake voice report" : "Record voice report"} active={Boolean(audio || recording)} onPress={onAudio} />
      </View>
      {photo && <Image accessibilityLabel="Visit evidence preview" source={{ uri: photo.uri }} className="h-[220px] w-full rounded-xl" />}
      {audio && <View className="flex-row items-center justify-between gap-3 rounded-lg bg-[#E9F5EF] p-3">
        <View className="flex-1">
          <Text className="font-extrabold text-[#205E49]">Voice sales report saved</Text>
          <Text className="mt-1 text-xs text-[#4F655C]">Listen once before sending if needed.</Text>
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={voiceStatus.playing ? "Pause voice report" : "Play voice report"}
          className="min-h-11 min-w-16 items-center justify-center rounded-lg border border-success px-3"
          onPress={() => voiceStatus.playing ? voicePlayer.pause() : voicePlayer.play()}
        >
          <Text className="font-black text-success">{voiceStatus.playing ? "Pause" : "Play"}</Text>
        </TouchableOpacity>
      </View>}
      <Button label={selfCreated ? "Send for admin review" : "Complete visit"} disabled={!accessAllowed || !photo || !audio || recording} onPress={onFinish} />
      <DangerOutlineButton label={selfCreated ? "Discard marked-place draft" : "Discard visit draft"} onPress={onDiscard} />
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

function SyncQueue({
  queue,
  locationPending,
  locationRejected,
  locationSyncError,
  activity,
  online,
  lastSyncAt,
  onRetry,
  onRetryItem,
  onClearRejectedLocations,
  onRefresh,
}: {
  queue: QueueItem[];
  locationPending: number;
  locationRejected: number;
  locationSyncError: string;
  activity: ServerActivity[];
  online: boolean | null;
  lastSyncAt: string;
  onRetry: () => void;
  onRetryItem: (id: string) => void;
  onClearRejectedLocations: () => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "places" | "sales">("all");
  const pendingOperations = queue.filter((item) => item.state !== "confirmed");
  const failed = pendingOperations.filter((item) => item.state === "failed").length + locationRejected + (locationSyncError ? 1 : 0);
  const authFailed = pendingOperations.some((item) => item.errorKind === "auth");
  const syncing = pendingOperations.some((item) => item.state === "syncing");
  const pending = pendingOperations.length + locationPending + locationRejected;
  const visibleActivity = activity.filter((item) => (
    filter === "all" || (filter === "places" ? item.kind === "place" || item.kind === "visit" : item.kind === "order")
  ));
  const awaitingReview = activity.filter((item) => item.status === "pending_review").length;
  const approvedPlaces = activity.filter((item) => item.kind === "place" && item.status === "approved").length;
  const syncTitle = online === false
    ? "Offline — work is safe"
    : pending === 0
      ? "Everything is up to date"
      : syncing
        ? "Sending your work now"
        : `${pending} ${pending === 1 ? "item" : "items"} waiting`;
  return <>
    <View className="gap-2">
      <Eyebrow>ACTIVITY & SYNC</Eyebrow>
      <ScreenTitle>Your field timeline</ScreenTitle>
      <BodyText>See what happened today, what reached the office, and which new places are waiting for admin review.</BodyText>
    </View>
    <View className="overflow-hidden rounded-2xl bg-ink p-5">
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1">
          <Text className="text-xs font-black uppercase tracking-widest text-[#93A4C4]">
            {online === null ? "CHECKING CONNECTION" : online ? "ONLINE · AUTO SYNC ON" : "NO INTERNET · AUTO RETRY ON"}
          </Text>
          <Text className="mt-2 text-2xl font-black text-white">{syncTitle}</Text>
          <Text className="mt-2 leading-5 text-[#C9D3E6]">
            {authFailed
              ? "Your session expired. Saved work is safe—open Profile, sign out, then sign in with the same account."
              : failed > 0
              ? `${failed} ${failed === 1 ? "upload needs" : "uploads need"} attention. Open the details below to retry.`
              : lastSyncAt
                ? `Last office update ${new Date(lastSyncAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}.`
                : "FieldOPS sends saved work automatically when the internet is available."}
          </Text>
        </View>
        <View className={classes("h-12 min-w-12 items-center justify-center rounded-full px-3", pending === 0 ? "bg-[#1E5A49]" : "bg-[#253A63]")}>
          <Text className="font-black text-white">{pending}</Text>
        </View>
      </View>
      <View className="mt-5 flex-row gap-2">
        <View className="flex-1"><Button label={syncing ? "Sending…" : "Sync now"} onPress={onRetry} disabled={syncing || online === false} /></View>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Refresh activity from office" className="min-h-12 flex-1 items-center justify-center rounded-xl border border-[#7081A8] px-3" onPress={onRefresh}>
          <Text className="font-black text-white">Refresh activity</Text>
        </TouchableOpacity>
      </View>
    </View>
    <View className="flex-row justify-between border-y border-line py-4">
      <Stat value={`${activity.length}`} label="Today’s events" />
      <Stat value={`${awaitingReview}`} label="Awaiting admin" />
      <Stat value={`${approvedPlaces}`} label="Places approved" />
    </View>

    <View className="flex-row flex-wrap gap-2">
      <Choice label="All activity" selected={filter === "all"} onPress={() => setFilter("all")} />
      <Choice label="Visits & places" selected={filter === "places"} onPress={() => setFilter("places")} />
      <Choice label="Sales" selected={filter === "sales"} onPress={() => setFilter("sales")} />
    </View>
    {visibleActivity.length === 0
      ? <EmptyState title="No activity in this view" body={filter === "all" ? "Start work or record a visit. Confirmed events will stay visible here after they upload." : "Choose All activity or record new field work."} />
      : <View className="overflow-hidden rounded-2xl border border-line bg-white">
        {visibleActivity.map((item) => <View key={item.id} className="min-h-[78px] flex-row items-start gap-3 border-b border-line px-4 py-4 last:border-b-0">
          <View className={classes(
            "h-9 w-9 items-center justify-center rounded-full",
            item.status === "approved" ? "bg-[#DFF3E9]" : item.status === "rejected" ? "bg-[#FCEDEA]" : item.status === "pending_review" ? "bg-[#FFF1D0]" : "bg-[#E8EEF9]",
          )}><Text className="text-xs font-black text-ink">{item.kind === "place" ? "PIN" : item.kind === "visit" ? "VIS" : item.kind === "order" ? "PKR" : "DAY"}</Text></View>
          <View className="flex-1">
            <View className="flex-row items-start justify-between gap-3">
              <Text className="flex-1 font-extrabold text-ink">{item.title}</Text>
              <Text className={classes(
                "text-[10px] font-black uppercase tracking-wider",
                item.status === "approved" ? "text-success" : item.status === "rejected" ? "text-danger" : item.status === "pending_review" ? "text-[#8A6500]" : "text-field",
              )}>{item.status === "pending_review" ? "Admin review" : item.status === "approved" ? "Approved" : item.status === "rejected" ? "Rejected" : "Recorded"}</Text>
            </View>
            <Text className="mt-1 text-xs leading-4 text-muted">{item.detail}</Text>
            <Text className="mt-1.5 text-[10px] font-bold text-muted">
              {new Date(item.occurredAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}
              {item.amount !== undefined ? ` · PKR ${item.amount.toLocaleString()}` : ""}
            </Text>
          </View>
        </View>)}
      </View>}

    <SectionTitle>Upload details</SectionTitle>
    <View className="flex-row items-center justify-between rounded-2xl border border-line bg-white p-4">
      <View className="flex-1 pr-4">
          <Text className="font-black text-ink">Route points</Text>
          <Text className="mt-1 text-xs leading-4 text-muted">
            {locationRejected > 0
              ? `${locationRejected} invalid ${locationRejected === 1 ? "point needs" : "points need"} your confirmation before removal`
              : "Saved location updates waiting to reach the office"}
          </Text>
        </View>
      <View className={classes("h-11 min-w-11 items-center justify-center rounded-xl px-3", locationRejected > 0 ? "bg-[#FCEDEA]" : "bg-[#E8EEF9]")}>
        <Text className={classes("text-xl font-black", locationRejected > 0 ? "text-danger" : "text-field")}>{locationPending + locationRejected}</Text>
      </View>
    </View>
    {locationRejected > 0 && <View className="rounded-xl border border-[#E9B8AF] bg-[#FCEDEA] p-4">
      <Text className="font-black text-danger">Invalid route data was isolated</Text>
      <Text className="mt-1 text-xs leading-5 text-[#7A4238]">These points no longer block valid route uploads. Remove only the rejected copies after confirming this message.</Text>
      <View className="mt-3 items-start"><CompactAction label="Remove invalid points" onPress={onClearRejectedLocations} /></View>
    </View>}
    {locationSyncError && <View className="rounded-xl border border-[#E9B8AF] bg-[#FCEDEA] p-4">
      <Text className="font-black text-danger">Route upload needs attention</Text>
      <Text className="mt-1 text-xs leading-5 text-[#7A4238]">{locationSyncError.includes("401") ? "Your session expired. Sign out from Profile, then sign in with the same account; the route is safe." : `${locationSyncError} FieldOPS will retry automatically.`}</Text>
    </View>}
    {pendingOperations.length === 0
      ? <InfoNotice title="No uploads waiting" body="Everything currently saved on this phone has reached the server." />
      : <View className="overflow-hidden rounded-2xl border border-line bg-white">
        {pendingOperations.map((item) => <View key={item.id} className="border-b border-line p-4 last:border-b-0">
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="font-extrabold text-ink">{item.label}</Text>
              <Text className={classes("mt-1 text-xs font-bold", item.state === "failed" ? "text-danger" : "text-muted")}>
                {item.state === "syncing"
                  ? "Sending now…"
                  : item.state === "failed"
                    ? item.errorKind === "validation" || item.errorKind === "auth" ? "Needs attention" : "Retry scheduled"
                    : "Queued safely on this phone"}
              </Text>
              {item.error && <Text className="mt-1 text-xs leading-4 text-muted">{item.error}</Text>}
              {item.attempts > 0 && <Text className="mt-1 text-[10px] font-bold text-muted">{item.attempts} {item.attempts === 1 ? "attempt" : "attempts"}</Text>}
            </View>
            {item.state === "failed" && <CompactAction label="Retry" onPress={() => onRetryItem(item.id)} />}
          </View>
        </View>)}
      </View>}
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
      <BodyText>Field sales account</BodyText>
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

function Nav({ screen, pending, setScreen }: { screen: Screen; pending: number; setScreen: (screen: Screen) => void }) {
  const items: { key: Screen; label: string; icon: string }[] = [
    { key: "today", label: "Today", icon: "●" },
    { key: "route", label: "Visits", icon: "⌖" },
    { key: "order", label: "Order", icon: "▤" },
    { key: "sync", label: "Activity", icon: "↻" },
    { key: "profile", label: "Profile", icon: "○" },
  ];
  const selectedKey: Screen = screen === "visit" || screen === "new_visit" ? "route" : screen;
  return <View accessibilityRole="tablist" className="mx-3.5 mb-2 flex-row rounded-2xl border border-[#253652] bg-ink p-1.5">
    {items.map((item) => <TouchableOpacity
      key={item.key}
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: selectedKey === item.key }}
      className={classes(
        "min-h-12 flex-1 items-center justify-center rounded-xl border",
        selectedKey === item.key ? "border-[#4F7CE8] bg-[#254A9A]" : "border-transparent",
      )}
      onPress={() => setScreen(item.key)}
    >
      <View className="relative">
        <Text className={classes("text-center text-sm font-black", selectedKey === item.key ? "text-white" : "text-[#AAB3C5]")}>{item.icon}</Text>
        {item.key === "sync" && pending > 0 && <View className="absolute -right-3 -top-1 min-w-4 items-center rounded-full bg-gold px-1"><Text className="text-[8px] font-black text-ink">{pending > 9 ? "9+" : pending}</Text></View>}
      </View>
      <Text className={classes("mt-0.5 text-[9px] font-extrabold", selectedKey === item.key ? "text-white" : "text-[#AAB3C5]")}>{item.label}</Text>
    </TouchableOpacity>)}
  </View>;
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    className={classes(
      "min-h-12 items-center justify-center rounded-xl bg-[#2563EB] px-4 py-3",
      disabled && "opacity-45",
    )}
    onPress={onPress}
    disabled={disabled}
  >
    <Text className="font-black text-white">{label}</Text>
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

function DangerOutlineButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    className="min-h-12 items-center justify-center rounded-[9px] border border-danger bg-white px-4 py-3"
    onPress={onPress}
  >
    <Text className="font-black text-danger">{label}</Text>
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

function CompactAction({ label, onPress }: { label: string; onPress: () => void }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    className="min-h-11 items-center justify-center rounded-lg border border-field bg-[#EEF3FC] px-3"
    onPress={onPress}
  >
    <Text className="text-xs font-black text-field">{label}</Text>
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

function PlaceReviewStatus({ status, visitStatus }: { status?: PlaceApprovalStatus; visitStatus: VisitStatus }) {
  if (visitStatus === "active") return <Status status="active" />;
  const label = status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : visitStatus === "completed" ? "Admin review" : "Draft";
  return <Text className={classes(
    "text-[9px] font-black uppercase",
    status === "approved" ? "text-success" : status === "rejected" ? "text-danger" : "text-[#8A6500]",
  )}>{label}</Text>;
}

function PlaceReviewNotice({ outlet }: { outlet: Outlet }) {
  if (outlet.placeApprovalStatus === "approved") {
    return <InfoNotice
      title="Permanent place approved"
      body={`${outlet.name} is now saved at your verified point. Admin can correct the official name later without moving the location.`}
    />;
  }
  if (outlet.placeApprovalStatus === "rejected") {
    return <WarningNotice
      title="A new report is needed"
      body="Admin could not approve this place. Check Activity for the review note, then mark the customer again with clear evidence."
    />;
  }
  return <WarningNotice
    title="Waiting for admin review"
    body="Your point, photo, and voice sales report reached the office. Admin will confirm the territory and official name before saving this as a permanent outlet."
  />;
}

function ProcessSteps({ current, labels }: { current: number; labels: string[] }) {
  return <View accessibilityRole="summary" className="flex-row rounded-2xl border border-line bg-white px-2 py-4">
    {labels.map((label, index) => {
      const step = index + 1;
      const done = step < current;
      const active = step === current;
      return <View key={label} className="flex-1 items-center px-0.5">
        <View className={classes(
          "h-7 w-7 items-center justify-center rounded-full border",
          done ? "border-success bg-success" : active ? "border-field bg-field" : "border-line bg-white",
        )}>
          <Text className={classes("text-[10px] font-black", done || active ? "text-white" : "text-muted")}>{done ? "✓" : step}</Text>
        </View>
        <Text className={classes("mt-2 text-center text-[9px] font-extrabold leading-3", active ? "text-field" : "text-muted")}>{label}</Text>
      </View>;
    })}
  </View>;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <Text className="text-[10px] font-black tracking-[1.1px] text-muted">{children}</Text>;
}

function ScreenTitle({ children }: { children: React.ReactNode }) {
  return <Text accessibilityRole="header" className="text-[30px] font-black leading-9 text-ink">{children}</Text>;
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
