import "../global.css";

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import {
  DEFAULT_ROUTE_TRACKING_POLICY,
  distanceMeters,
  hasRequiredVisitEvidence,
  isReliableRoutePoint,
  MAX_PLACE_MARK_ACCURACY_METERS,
  mergeRefreshedVisits,
  normalizeRouteTrackingPolicy,
  parseTerritoryBoundary,
  pointInAnyTerritory,
  shouldCaptureRoutePoint,
  type RouteTrackPoint,
  type RouteTrackingPolicy,
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
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import {
  backgroundRouteStatus,
  clearRejectedLocationPoints,
  flushLocationQueue,
  locationQueueCount,
  locationQueueStats,
  queueLocationObjects,
  requestBackgroundRoutePermission,
  resumeLocationQueueAfterAuthentication,
  setBackgroundRoutePreference,
  startBackgroundRouteTracking,
  stopBackgroundRouteTracking,
  type BackgroundRouteStatus,
} from "../lib/background-location";
import { networkSyncMode, shouldAttemptImmediateUpload } from "../lib/automatic-sync";
import { fetchWithTimeout, retryAfterDelayMs } from "../lib/network";
import {
  appendUniqueOutboxRecord,
  createDurableOutboxController,
  findEquivalentOutboxRecord,
  normalizeRestoredOutbox,
  operationRetryDecision,
  resumeAuthFailedOutboxRecords,
  resumeInterruptedOutboxRecords,
  selectOutboxCandidates,
  type DurableOutboxController,
} from "../lib/operation-outbox";
import {
  routeLocationCadence,
} from "../lib/background-route-policy";
import {
  clearSecureMobileSession,
  readSecureMobileSession,
  saveSecureMobileSession,
  type SecureMobileSession,
} from "../lib/secure-session";
import {
  dealFollowUpStatus,
  dealStages,
  isDealStage,
  normalizeDeals,
  type Deal,
  type DealStage,
} from "../lib/team-data";
import {
  createVisitEvidenceFormData,
  type EvidenceAttachment,
} from "../lib/visit-evidence-form";

type Screen = "today" | "route" | "new_visit" | "visit" | "order" | "deals" | "sync" | "profile";
type VisitStatus = "planned" | "active" | "completed";
type PlaceApprovalStatus = "not_applicable" | "pending_review" | "approved" | "rejected";
type WorkState = "not_started" | "active" | "finished";
type FieldAction = "start_work" | "finish_work" | "start_visit" | "start_place" | "finish_visit" | "save_order";
type Session = { token: string; expiresAt: string; employee: { id: string; name: string } };
type PersistedSessionMetadata = Omit<Session, "token">;
type JsonOperation = { type: "json"; path: string; body: Record<string, unknown> };
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
  errorKind?: "connection" | "auth" | "validation" | "conflict" | "server";
  retryable?: boolean;
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
type MobileOperationsPolicy = RouteTrackingPolicy & { syncIntervalSeconds: number };
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
type DealDraft = {
  outletId: string;
  customerName: string;
  title: string;
  stage: DealStage;
  amount: number | null;
  nextAction: string;
  followUpAt: string;
  notes: string;
};
type PersistedState = {
  session: PersistedSessionMetadata | null;
  workState: WorkState;
  outlets: Outlet[];
  queue: QueueItem[];
  activeVisit: ActiveVisit | null;
  territoryPolicy: TerritoryPolicy;
  operationsPolicy: MobileOperationsPolicy;
  contextDate: string;
  serverActivity: ServerActivity[];
  deals: Deal[];
  lastSyncAt: string;
};
type ParsedPersistedState = Omit<PersistedState, "session"> & {
  session: Session | null;
  storedEmployeeId: string;
};

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://fieldops.sherazwaqar.tech/api/v1";
// In-product identity is deliberately separate from launcher configuration.
// Use the named master so a header never resolves a retained legacy icon asset.
const FIELDOPS_MARK = require("../assets/brand/ribbon-heart-master.png");
export const STORAGE_KEY = "fieldops-production-state-v3";
const OUTBOX_STORAGE_KEY = "fieldops-production-outbox-v1";
const RECOVERY_EMPLOYEE_STORAGE_KEY = "fieldops-recovery-employee-v1";
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const GEOFENCE_METERS = 70;
const GPS_FIX_TIMEOUT_MS = 18_000;
const defaultOperationsPolicy: MobileOperationsPolicy = { ...DEFAULT_ROUTE_TRACKING_POLICY, syncIntervalSeconds: 15 };
const defaultBackgroundRouteStatus: BackgroundRouteStatus = {
  supported: true,
  permission: "undetermined",
  canAskAgain: true,
  enabled: false,
  running: false,
};
const emptyPermissions: PermissionState = {
  foreground: false,
  camera: false,
  microphone: false,
  services: false,
};
const unrestrictedTerritoryPolicy: TerritoryPolicy = { mode: "unrestricted", assignedCount: 0, territories: [] };

function normalizeMobileOperationsPolicy(value: unknown): MobileOperationsPolicy {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const syncInterval = Number(record.syncIntervalSeconds);
  return {
    ...normalizeRouteTrackingPolicy(record),
    syncIntervalSeconds: Number.isFinite(syncInterval)
      ? Math.min(120, Math.max(10, Math.round(syncInterval)))
      : defaultOperationsPolicy.syncIntervalSeconds,
  };
}

class RequestError extends Error {
  constructor(message: string, readonly status = 0, readonly retryAfterMs?: number) {
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
    // Chat was removed from FieldOPS. Retire legacy queued chat/read receipts so
    // an upgraded phone cannot keep showing unsendable work in Activity.
    if (operation?.type === "json" && operation.path === "/team/messages") return [];
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
  if (!saved) {
    const migrated = migratePersistedVisits(fallback, activeVisit);
    return { ...migrated, queue: normalizeRestoredOutbox(migrated.queue) };
  }
  try {
    const value = JSON.parse(saved) as unknown;
    if (!Array.isArray(value)) {
      const migrated = migratePersistedVisits(fallback, activeVisit);
      return { ...migrated, queue: normalizeRestoredOutbox(migrated.queue) };
    }
    const migrated = migratePersistedVisits(
      value.filter((item): item is QueueItem => Boolean(item && typeof item === "object")),
      activeVisit,
    );
    return { ...migrated, queue: normalizeRestoredOutbox(migrated.queue) };
  } catch {
    const migrated = migratePersistedVisits(fallback, activeVisit);
    return { ...migrated, queue: normalizeRestoredOutbox(migrated.queue) };
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

function locallyPersistedSession(session: Session | null): PersistedSessionMetadata | null {
  if (!session) return null;
  return {
    expiresAt: session.expiresAt,
    employee: { ...session.employee },
  };
}

function parseState(saved: string, secureSession: SecureMobileSession | null): ParsedPersistedState | null {
  try {
    const value = JSON.parse(saved) as Partial<PersistedState>;
    if (!value || !Array.isArray(value.outlets) || !Array.isArray(value.queue)) return null;
    const rawSession = value.session as (Partial<PersistedSessionMetadata> & { token?: unknown }) | null | undefined;
    const rawEmployee = rawSession?.employee as Partial<Session["employee"]> | null | undefined;
    const storedEmployeeId = typeof rawEmployee?.id === "string" ? rawEmployee.id : "";
    const session = (
      typeof rawSession?.expiresAt === "string"
      && Date.parse(rawSession.expiresAt) > Date.now()
      && storedEmployeeId
      && typeof rawEmployee?.name === "string"
      && secureSession?.employeeId === storedEmployeeId
      && typeof secureSession.token === "string"
      && secureSession.token.length > 0
    ) ? {
      token: secureSession.token,
      expiresAt: rawSession.expiresAt,
      employee: { id: storedEmployeeId, name: rawEmployee.name },
    } : null;
    const persisted = migratePersistedVisits(
      value.queue.filter((item) => item?.state === "confirmed" || Boolean(item?.operation)),
      value.activeVisit,
    );
    return {
      storedEmployeeId,
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
      operationsPolicy: normalizeMobileOperationsPolicy(value.operationsPolicy),
      contextDate: typeof value.contextDate === "string" ? value.contextDate : "",
      serverActivity: Array.isArray(value.serverActivity) ? value.serverActivity : [],
      deals: normalizeDeals(value.deals),
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
  if (!response.ok) throw new RequestError(
    body.error || "The FieldOPS server could not complete this request.",
    response.status,
    retryAfterDelayMs(response.headers.get("retry-after")),
  );
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

function routeTrackPoint(location: Location.LocationObject): RouteTrackPoint {
  return {
    capturedAt: new Date(location.timestamp).toISOString(),
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy ?? Number.POSITIVE_INFINITY,
    speed: location.coords.speed,
  };
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
  const contentScrollRef = useRef<ScrollView>(null);
  useEffect(() => { contentScrollRef.current?.scrollTo({ y: 0, animated: false }); }, [screen]);
  const [workState, setWorkState] = useState<WorkState>("not_started");
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeVisit, setActiveVisit] = useState<ActiveVisit | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const audioRecorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: "document" });
  const audioRecorderState = useAudioRecorderState(audioRecorder, 250);
  const [recording, setRecording] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState>(emptyPermissions);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const [backgroundRoute, setBackgroundRoute] = useState<BackgroundRouteStatus>(defaultBackgroundRouteStatus);
  const [backgroundRouteBusy, setBackgroundRouteBusy] = useState(false);
  const [locationPending, setLocationPending] = useState(0);
  const [locationRejected, setLocationRejected] = useState(0);
  const [locationSyncError, setLocationSyncError] = useState("");
  const [recoveryEmployeeId, setRecoveryEmployeeId] = useState("");
  const [territoryPolicy, setTerritoryPolicy] = useState<TerritoryPolicy>(unrestrictedTerritoryPolicy);
  const [operationsPolicy, setOperationsPolicy] = useState<MobileOperationsPolicy>(defaultOperationsPolicy);
  const [contextDate, setContextDate] = useState("");
  const [territoryPosition, setTerritoryPosition] = useState<TerritoryPosition>("checking");
  const [locationChecking, setLocationChecking] = useState(false);
  const [lastLocationCheck, setLastLocationCheck] = useState<{ accuracy: number; checkedAt: string } | null>(null);
  const [networkOnline, setNetworkOnline] = useState<boolean | null>(null);
  const [serverActivity, setServerActivity] = useState<ServerActivity[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [fieldAction, setFieldAction] = useState<FieldAction | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState("");
  const [officeSyncError, setOfficeSyncError] = useState("");
  const queueRef = useRef<QueueItem[]>([]);
  const durableQueueControllerRef = useRef<DurableOutboxController<QueueItem> | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const recoveryEmployeeIdRef = useRef("");
  const sessionEpochRef = useRef(0);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncRequestedRef = useRef(false);
  const syncForceRequestedRef = useRef(false);
  const contextRequestRef = useRef<{ token: string; promise: Promise<void> } | null>(null);
  const lastContextRefreshRef = useRef<{ token: string; at: number } | null>(null);
  const manualSyncPromiseRef = useRef<Promise<void> | null>(null);
  const fieldActionRef = useRef<FieldAction | null>(null);
  const permissionPrompted = useRef(false);
  const lastCapturedRoutePointRef = useRef<RouteTrackPoint | null>(null);
  const routeCapturePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const networkOnlineRef = useRef<boolean | null>(null);

  if (!durableQueueControllerRef.current) {
    durableQueueControllerRef.current = createDurableOutboxController<QueueItem>({
      readCurrent: () => queueRef.current,
      persist: async (records) => {
        try {
          await persistDurableQueue([...records]);
        } catch {
          throw new Error("FieldOPS could not safely save this work on your phone. Check available storage and try again.");
        }
      },
      publish: (records) => {
        queueRef.current = records;
        setQueue(records);
      },
    });
  }

  const selected = outlets.find((outlet) => outlet.id === selectedId) ?? outlets[0];
  const assignedOutlets = outlets.filter((outlet) => outlet.kind === "assigned");
  const selfVisits = outlets.filter((outlet) => outlet.kind === "self");
  const completed = assignedOutlets.filter((outlet) => outlet.status === "completed").length;
  const employeeQueue = useMemo(
    () => session ? queue.filter((item) => item.employeeId === session.employee.id) : [],
    [queue, session?.employee.id],
  );
  const pending = employeeQueue.filter((item) => item.state === "failed" || item.state === "pending" || item.state === "syncing").length + locationPending + locationRejected;
  const syncing = manualSyncing || employeeQueue.some((item) => item.state === "syncing");
  const needsSyncAttention = employeeQueue.filter((item) => item.state === "failed" && item.retryable === false).length + locationRejected;
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

  function setQueueDurably(update: (items: QueueItem[]) => QueueItem[]) {
    return durableQueueControllerRef.current!.update((items) => trimQueue(update(items)));
  }

  function beginFieldAction(action: FieldAction) {
    if (fieldActionRef.current) return false;
    fieldActionRef.current = action;
    setFieldAction(action);
    return true;
  }

  function endFieldAction(action: FieldAction) {
    if (fieldActionRef.current !== action) return;
    fieldActionRef.current = null;
    setFieldAction(null);
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
      readSecureMobileSession(),
    ]).then(async ([saved, savedOutbox, savedRecoveryEmployeeId, secureSession]) => {
      if (cancelled) return;
      const value = saved ? parseState(saved, secureSession) : null;
      if (!value) {
        const parsed = parseDurableQueue(savedOutbox, [], null);
        const unconfirmedOwners = [...new Set(parsed.queue
          .filter((item) => item.state !== "confirmed" && item.employeeId)
          .map((item) => item.employeeId))];
        const secureRouteOwner = secureSession?.employeeId ?? "";
        const hasSecureOwnerRoute = secureRouteOwner
          ? await locationQueueCount(secureRouteOwner).then((count) => count > 0).catch(() => true)
          : false;
        if (cancelled) return;
        const recoveryOwner = savedRecoveryEmployeeId
          || (unconfirmedOwners.length === 1 ? unconfirmedOwners[0]! : "")
          || (hasSecureOwnerRoute ? secureRouteOwner : "");
        const recoveredQueue = scopeLegacyQueue(parsed.queue, recoveryOwner);
        queueRef.current = recoveredQueue;
        setQueue(recoveredQueue);
        if (recoveryOwner) {
          recoveryEmployeeIdRef.current = recoveryOwner;
          setRecoveryEmployeeId(recoveryOwner);
          AsyncStorage.setItem(RECOVERY_EMPLOYEE_STORAGE_KEY, recoveryOwner).catch(() => undefined);
        }
        persistDurableQueue(recoveredQueue).catch(() => undefined);
        if (secureSession) await clearSecureMobileSession().catch(() => undefined);
        return;
      }
      const parsed = parseDurableQueue(savedOutbox, value.queue, value.activeVisit);
      const hasUnconfirmedWork = Boolean(parsed.activeVisit)
        || parsed.queue.some((item) => item.state !== "confirmed");
      const unconfirmedOwners = [...new Set(parsed.queue
        .filter((item) => item.state !== "confirmed" && item.employeeId)
        .map((item) => item.employeeId))];
      const inferredOwnerId = value.storedEmployeeId
        || (unconfirmedOwners.length === 1 ? unconfirmedOwners[0]! : "");
      const hasQueuedRoute = !value.session && inferredOwnerId
        ? await locationQueueCount(inferredOwnerId).then((count) => count > 0).catch(() => true)
        : false;
      if (cancelled) return;
      const recoveryOwner = savedRecoveryEmployeeId
        || (!value.session && (hasUnconfirmedWork || hasQueuedRoute) ? inferredOwnerId : "");
      const legacyOwnerId = recoveryOwner || value.session?.employee.id || value.storedEmployeeId;
      const persisted = { ...parsed, queue: scopeLegacyQueue(parsed.queue, legacyOwnerId) };
      const ownerQueue = legacyOwnerId
        ? persisted.queue.filter((item) => item.employeeId === legacyOwnerId)
        : [];
      const restoredOutlets = applyConfirmedVisitStatuses(value.outlets, ownerQueue);
      const restoredActiveVisit = persisted.activeVisit
        && hasQueuedVisitSubmission(ownerQueue, persisted.activeVisit.id)
        ? null
        : persisted.activeVisit;
      const restoredSession = recoveryOwner ? null : value.session;
      const cleanSignedOutState = !restoredSession && !recoveryOwner;
      const restoredQueue = cleanSignedOutState ? [] : persisted.queue;
      recoveryEmployeeIdRef.current = recoveryOwner;
      setRecoveryEmployeeId(recoveryOwner);
      if (recoveryOwner) {
        AsyncStorage.setItem(RECOVERY_EMPLOYEE_STORAGE_KEY, recoveryOwner).catch(() => undefined);
      }
      sessionRef.current = restoredSession;
      setSession(restoredSession);
      setWorkState(cleanSignedOutState ? "not_started" : value.workState);
      setOutlets(cleanSignedOutState ? [] : restoredOutlets);
      setQueue(restoredQueue);
      queueRef.current = restoredQueue;
      setActiveVisit(cleanSignedOutState ? null : restoredActiveVisit);
      setTerritoryPolicy(cleanSignedOutState ? unrestrictedTerritoryPolicy : value.territoryPolicy);
      setOperationsPolicy(cleanSignedOutState ? defaultOperationsPolicy : value.operationsPolicy);
      setContextDate(cleanSignedOutState ? "" : value.contextDate);
      setServerActivity(cleanSignedOutState ? [] : value.serverActivity);
      setDeals(cleanSignedOutState ? [] : value.deals);
      setLastSyncAt(cleanSignedOutState ? "" : value.lastSyncAt);
      setTerritoryPosition(cleanSignedOutState || value.territoryPolicy.mode === "restricted" ? "checking" : "unrestricted");
      if (!cleanSignedOutState && restoredActiveVisit) setSelectedId(restoredActiveVisit.outletId);
      else if (!cleanSignedOutState && restoredOutlets[0]) setSelectedId(restoredOutlets[0].id);
      persistDurableQueue(restoredQueue).catch(() => undefined);
      if (restoredSession) {
        resumeLocationQueueAfterAuthentication(restoredSession.employee.id)
          .then(() => flushLocationQueue(restoredSession.employee.id, restoredSession.token))
          .then(() => refreshLocationCount())
          .catch(() => undefined);
      } else if (secureSession) {
        await clearSecureMobileSession().catch(() => undefined);
      }
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      session: locallyPersistedSession(session),
      workState,
      outlets,
      queue,
      activeVisit,
      territoryPolicy,
      operationsPolicy,
      contextDate,
      serverActivity,
      deals,
      lastSyncAt,
    })).catch(() => undefined);
  }, [activeVisit, contextDate, deals, hydrated, lastSyncAt, operationsPolicy, outlets, queue, serverActivity, session, territoryPolicy, workState]);

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
    if (!hydrated || (session && !permissionChecked)) return;
    let cancelled = false;
    const reconcile = async () => {
      const authenticatedSession = session;
      if (!authenticatedSession || workState !== "active" || !trackingReady) {
        await stopBackgroundRouteTracking();
      } else {
        const status = await backgroundRouteStatus(authenticatedSession.employee.id);
        if (status.enabled && status.supported && status.permission === "granted") {
          await startBackgroundRouteTracking({
            employeeId: authenticatedSession.employee.id,
            token: authenticatedSession.token,
            expiresAt: authenticatedSession.expiresAt,
            policy: operationsPolicy,
            lastAcceptedPoint: lastCapturedRoutePointRef.current,
          }).catch(async (error) => {
            await stopBackgroundRouteTracking();
            if (!cancelled) {
              setLocationSyncError(error instanceof Error ? error.message : "Screen-lock route continuity could not start.");
            }
          });
        } else {
          await stopBackgroundRouteTracking();
        }
      }
      const next = authenticatedSession
        ? await backgroundRouteStatus(authenticatedSession.employee.id)
        : defaultBackgroundRouteStatus;
      if (!cancelled) setBackgroundRoute(next);
    };
    void reconcile();
    return () => { cancelled = true; };
  }, [backgroundRoute.enabled, backgroundRoute.permission, backgroundRoute.running, backgroundRoute.supported, hydrated, operationsPolicy, permissionChecked, session?.token, trackingReady, workState]);

  useEffect(() => {
    if (!hydrated || !session) return;
    refreshContext(false).catch(() => undefined);
    syncOperations().catch(() => undefined);
    refreshLocationCount().catch(() => undefined);
  }, [hydrated, session?.token]);

  useEffect(() => {
    if (!hydrated || !session || (screen !== "sync" && screen !== "deals") || networkOnline === false) return;
    refreshContext(false).catch(() => undefined);
    const timer = setInterval(() => refreshContext(false).catch(() => undefined), 45_000);
    return () => clearInterval(timer);
  }, [hydrated, networkOnline, screen, session?.token]);

  useEffect(() => {
    if (!hydrated || !session || !permissionChecked || !permissionReady || !territoryPolicyReady || territoryPosition !== "checking") return;
    checkMyLocation(false, territoryPolicy).catch(() => undefined);
  }, [contextDate, hydrated, permissionChecked, permissionReady, session?.token, territoryPolicy, territoryPosition]);

  useEffect(() => {
    if (!session || workState !== "active") {
      lastCapturedRoutePointRef.current = null;
      return;
    }
    if (!trackingReady || backgroundRoute.running) return;

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const authenticatedSession = session;
    const sessionEpoch = sessionEpochRef.current;

    const receiveLocation = (location: Location.LocationObject) => {
      if (cancelled) return;
      routeCapturePromiseRef.current = routeCapturePromiseRef.current.then(async () => {
        if (cancelled || !sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
        const candidate = routeTrackPoint(location);
        if (!shouldCaptureRoutePoint(lastCapturedRoutePointRef.current, candidate, operationsPolicy)) return;
        await queueLocationObjects(authenticatedSession.employee.id, [location], "foreground");
        lastCapturedRoutePointRef.current = candidate;
        if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
        await refreshLocationCount();
        if (shouldAttemptImmediateUpload(networkOnlineRef.current)) {
          void flushLocationQueue(authenticatedSession.employee.id, authenticatedSession.token)
            .then(() => sessionIsCurrent(authenticatedSession, sessionEpoch) ? refreshLocationCount() : undefined)
            .catch(() => undefined);
        }
      }).catch((error) => {
        if (!cancelled) setLocationSyncError(error instanceof Error ? error.message : "Route point could not be saved on this phone.");
      });
    };

    const startTracking = async () => {
      try {
        const cadence = routeLocationCadence(operationsPolicy);
        const started = await Location.watchPositionAsync({
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: cadence.timeInterval,
          distanceInterval: cadence.distanceInterval,
        }, receiveLocation);
        if (cancelled) started.remove();
        else subscription = started;
      } catch (error) {
        if (cancelled) return;
        setLocationSyncError(error instanceof Error ? error.message : "Route tracking could not start.");
        retryTimer = setTimeout(() => { void startTracking(); }, 15_000);
      }
    };
    void startTracking();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      subscription?.remove();
    };
  }, [backgroundRoute.running, operationsPolicy, session?.token, trackingReady, workState]);

  useEffect(() => {
    if (!hydrated || !session) return;
    const timer = setInterval(() => {
      refreshPermissions(false).catch(() => undefined);
      Promise.all([
        syncOperations(),
        flushLocationQueue(session.employee.id, session.token),
      ]).then(() => refreshLocationCount()).catch(() => undefined);
    }, operationsPolicy.syncIntervalSeconds * 1_000);
    const appSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refreshPermissions(false).catch(() => undefined);
        refreshBackgroundRouteStatus().catch(() => undefined);
        Promise.all([
          syncOperations(),
          flushLocationQueue(session.employee.id, session.token),
        ]).then(() => refreshLocationCount()).catch(() => undefined);
        refreshContext(false).catch(() => undefined);
      }
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      const online = Boolean(state.isConnected && state.isInternetReachable !== false);
      const mode = networkSyncMode(networkOnlineRef.current, online);
      networkOnlineRef.current = online;
      setNetworkOnline(online);
      if (mode !== "none") {
        const force = mode === "force";
        Promise.all([
          syncOperations({ force }),
          flushLocationQueue(session.employee.id, session.token, { force }),
        ]).then(() => refreshLocationCount()).catch(() => undefined);
        refreshPermissions(false).catch(() => undefined);
        refreshContext(false).catch(() => undefined);
      }
    });
    return () => {
      clearInterval(timer);
      appSubscription.remove();
      networkSubscription();
    };
  }, [hydrated, operationsPolicy.syncIntervalSeconds, session?.token, trackingReady, workState]);

  async function refreshLocationCount() {
    const employeeId = sessionRef.current?.employee.id;
    const stats = await locationQueueStats(employeeId);
    setLocationPending(stats.pending);
    setLocationRejected(stats.rejected);
    setLocationSyncError(stats.error);
  }

  async function refreshBackgroundRouteStatus() {
    const employeeId = sessionRef.current?.employee.id;
    if (!employeeId) {
      setBackgroundRoute(defaultBackgroundRouteStatus);
      return defaultBackgroundRouteStatus;
    }
    const next = await backgroundRouteStatus(employeeId);
    setBackgroundRoute(next);
    return next;
  }

  function enableBackgroundRoute() {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession || backgroundRouteBusy) return;
    const systemStep = Platform.OS === "android"
      ? "Android may open phone settings. Choose Allow all the time, then return to FieldOPS."
      : "iPhone will ask for Always location access after the normal While Using permission.";
    Alert.alert(
      "Keep the route through screen lock?",
      `This is optional. When enabled, FieldOPS records the work route while the screen is locked or another app is open—but only between Start work and Finish session. ${systemStep}`,
      [
        { text: "Not now", style: "cancel" },
        { text: "Continue", onPress: () => {
          setBackgroundRouteBusy(true);
          (async () => {
            const current = await backgroundRouteStatus(authenticatedSession.employee.id);
            if (!current.supported) {
              Alert.alert("Not available on this phone", "Work will still record while FieldOPS is open.");
              return;
            }
            if (current.permission === "denied" && !current.canAskAgain) {
              await Linking.openSettings();
              return;
            }
            const permission = await requestBackgroundRoutePermission();
            if (!permission.granted) {
              await setBackgroundRoutePreference(authenticatedSession.employee.id, false);
              await stopBackgroundRouteTracking();
              Alert.alert("Screen-lock continuity is off", "You can keep working. FieldOPS will record the route whenever the app is open, and you can enable this later in Profile.");
              return;
            }
            await setBackgroundRoutePreference(authenticatedSession.employee.id, true);
            if (workState === "active" && trackingReady) {
              await startBackgroundRouteTracking({
                employeeId: authenticatedSession.employee.id,
                token: authenticatedSession.token,
                expiresAt: authenticatedSession.expiresAt,
                policy: operationsPolicy,
                lastAcceptedPoint: lastCapturedRoutePointRef.current,
              });
            }
            Alert.alert(
              "Screen-lock continuity enabled",
              workState === "active"
                ? "Your active work route can continue when the screen locks. Finish session or sign out to stop it."
                : "It will start automatically the next time you tap Start work.",
            );
          })().catch((error) => {
            Alert.alert("Could not enable continuity", `${error instanceof Error ? error.message : "Open phone settings and try again."} Your foreground route remains available.`);
          }).finally(() => {
            setBackgroundRouteBusy(false);
            refreshBackgroundRouteStatus().catch(() => undefined);
          });
        } },
      ],
    );
  }

  function disableBackgroundRoute() {
    const employeeId = sessionRef.current?.employee.id;
    if (!employeeId || backgroundRouteBusy) return;
    Alert.alert(
      "Turn off screen-lock continuity?",
      "The route will still record while FieldOPS is open during active work.",
      [
        { text: "Keep on", style: "cancel" },
        { text: "Turn off", style: "destructive", onPress: () => {
          setBackgroundRouteBusy(true);
          Promise.all([
            setBackgroundRoutePreference(employeeId, false),
            stopBackgroundRouteTracking(),
          ]).then(() => refreshBackgroundRouteStatus()).catch(() => {
            Alert.alert("Setting not changed", "Try again from Profile.");
          }).finally(() => setBackgroundRouteBusy(false));
        } },
      ],
    );
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
    const form = createVisitEvidenceFormData(
      operation.fields,
      operation.photo,
      operation.audio,
      (uri) => new File(uri),
    );
    const response = await fetchWithTimeout(`${API_BASE}${operation.path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${authenticatedSession.token}` },
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new RequestError(
      body.error || "Visit evidence could not be uploaded.",
      response.status,
      retryAfterDelayMs(response.headers.get("retry-after")),
    );
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
      let teamConflictNeedsRefresh = false;
      do {
        syncRequestedRef.current = false;
        syncForceRequestedRef.current = false;
        const now = Date.now();
        const candidates = selectOutboxCandidates(queueRef.current, authenticatedSession.employee.id, {
          force,
          onlyId,
          nowMs: now,
        });

        const processItem = async (item: QueueItem) => {
          if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return "auth" as const;
          const lastAttemptAt = new Date().toISOString();
          await setQueueDurably((items) => items.map((entry) => entry.id === item.id ? {
            ...entry,
            state: "syncing",
            lastAttemptAt,
            error: undefined,
            errorKind: undefined,
            retryable: undefined,
            httpStatus: undefined,
          } : entry));
          try {
            const confirmation = await executeOperation(item.operation!, authenticatedSession);
            if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return "auth" as const;
            applyDealConfirmation(item, confirmation);
            await setQueueDurably((items) => items.map((entry) => entry.id === item.id
              ? { ...entry, state: "confirmed", error: undefined, errorKind: undefined, retryable: undefined, httpStatus: undefined, nextAttemptAt: undefined }
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
            if (status === 409 && item.operation?.type === "json" && item.operation.path === "/deals") {
              teamConflictNeedsRefresh = true;
            }
            const attempts = item.attempts + 1;
            const retry = operationRetryDecision({
              status,
              attempts,
              retryAfterMs: error instanceof RequestError ? error.retryAfterMs : undefined,
            });
            await setQueueDurably((items) => items.map((entry) => {
              if (entry.id !== item.id) return entry;
              return {
                ...entry,
                state: "failed",
                attempts,
                errorKind: retry.errorKind,
                retryable: retry.retryable,
                ...(status ? { httpStatus: status } : {}),
                lastAttemptAt,
                nextAttemptAt: retry.nextAttemptAt,
                error: error instanceof Error ? error.message : "Connection interrupted. FieldOPS will retry.",
              };
            }));
            return retry.errorKind;
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
      if ((confirmedAny || teamConflictNeedsRefresh) && sessionIsCurrent(authenticatedSession, sessionEpoch)) {
        await refreshContext(false).catch(() => undefined);
      }
    })();
    syncPromiseRef.current = operation;
    return operation.finally(() => {
      if (syncPromiseRef.current !== operation) return;
      syncPromiseRef.current = null;
      if (syncRequestedRef.current && sessionIsCurrent(authenticatedSession, sessionEpoch)) {
        const forceTrailing = syncForceRequestedRef.current;
        setTimeout(() => syncOperations({ force: forceTrailing }).catch(() => undefined), 0);
      }
    });
  }

  async function retryQueueItem(id: string) {
    try {
      await setQueueDurably((items) => items.map((item) => item.id === id ? {
        ...item,
        state: "pending",
        nextAttemptAt: undefined,
        error: undefined,
        errorKind: undefined,
        retryable: undefined,
        httpStatus: undefined,
      } : item));
      await syncOperations({ force: true, onlyId: id });
    } catch (error) {
      Alert.alert("Retry not started", error instanceof Error ? error.message : "The saved work could not be updated on this phone.");
    }
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
    const existing = findEquivalentOutboxRecord(queueRef.current, item);
    if (existing) {
      await durableQueueControllerRef.current!.persistCurrent();
      if (existing.state !== "confirmed" && shouldAttemptImmediateUpload(networkOnlineRef.current)) {
        setTimeout(() => syncOperations().catch(() => undefined), 0);
      }
      return existing;
    }
    await setQueueDurably((items) => appendUniqueOutboxRecord(items, item));
    if (shouldAttemptImmediateUpload(networkOnlineRef.current)) {
      setTimeout(() => syncOperations().catch(() => undefined), 0);
    }
    return item;
  }

  function refreshContext(showMessage = true): Promise<void> {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession) return Promise.resolve();
    const activeRequest = contextRequestRef.current;
    if (activeRequest?.token === authenticatedSession.token) return activeRequest.promise;
    if (!showMessage
      && lastContextRefreshRef.current?.token === authenticatedSession.token
      && Date.now() - lastContextRefreshRef.current.at < 2_000) return Promise.resolve();
    const sessionEpoch = sessionEpochRef.current;
    const request = (async () => {
      setRefreshing(true);
      try {
        const context = await jsonRequest("/context", {}, { token: authenticatedSession.token });
        if (!sessionIsCurrent(authenticatedSession, sessionEpoch)) return;
        const today = String(context.date ?? pakistanWorkDate());
        const nextPolicy = normalizeTerritoryPolicy(context.territoryPolicy);
        const nextOperationsPolicy = normalizeMobileOperationsPolicy(context.operationsPolicy);
        setOutlets((current) => mergeRefreshedVisits(context.route as Outlet[], current, today));
        setServerActivity(Array.isArray(context.recentActivity) ? context.recentActivity as ServerActivity[] : []);
        setDeals(normalizeDeals(context.deals));
        setOfficeSyncError("");
        lastContextRefreshRef.current = { token: authenticatedSession.token, at: Date.now() };
        setLastSyncAt(new Date().toISOString());
        setTerritoryPolicy(nextPolicy);
        setOperationsPolicy(nextOperationsPolicy);
        setContextDate(today);
        setTerritoryPosition(nextPolicy.mode === "restricted" ? "checking" : "unrestricted");
        const hasPendingAttendance = queueRef.current.some((item) => (
          item.employeeId === authenticatedSession.employee.id
          &&
          item.operation?.type === "json"
          && item.operation.path === "/attendance"
          && item.state !== "confirmed"
          && !(item.state === "failed" && item.retryable === false)
        ));
        if (!hasPendingAttendance) setWorkState(context.workState ?? (context.shiftActive ? "active" : "not_started"));
        setSelectedId((current) => current || String(context.route[0]?.id ?? ""));
        checkMyLocation(false, nextPolicy).catch(() => undefined);
        if (showMessage) {
          const assignedCount = (context.route as Outlet[]).filter((outlet) => outlet.kind !== "self").length;
          Alert.alert("Today updated", `${assignedCount} assigned ${assignedCount === 1 ? "visit" : "visits"} and your latest activity are ready.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not refresh office activity.";
        if (sessionIsCurrent(authenticatedSession, sessionEpoch)) setOfficeSyncError(message);
        if (showMessage && sessionIsCurrent(authenticatedSession, sessionEpoch)) {
          Alert.alert("Working offline", message);
        }
      } finally {
        if (sessionIsCurrent(authenticatedSession, sessionEpoch)) setRefreshing(false);
      }
    })();
    contextRequestRef.current = { token: authenticatedSession.token, promise: request };
    return request.finally(() => {
      if (contextRequestRef.current?.promise === request) {
        contextRequestRef.current = null;
      }
    });
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
      await revokeMobileSession(result);
      throw new Error("This phone has unsynced work for another employee. Sign in with the same account to recover and upload it first.");
    }
    try {
      await saveSecureMobileSession({ employeeId: result.employee.id, token: result.token });
      // Persist only non-secret session metadata before publishing the session
      // to React state. A crash can therefore restore the secure credential,
      // while normal app storage never contains the bearer token.
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
        session: locallyPersistedSession(result),
        workState,
        outlets,
        queue: queueRef.current,
        activeVisit,
        territoryPolicy,
        operationsPolicy,
        contextDate,
        serverActivity,
        deals,
        lastSyncAt,
      } satisfies PersistedState));
      if (recoveryOwner) await AsyncStorage.removeItem(RECOVERY_EMPLOYEE_STORAGE_KEY);
    } catch (error) {
      await clearSecureMobileSession().catch(() => undefined);
      await revokeMobileSession(result);
      const detail = error instanceof Error ? error.message : "Secure phone storage was unavailable.";
      throw new Error(`FieldOPS could not safely finish sign-in. ${detail}`);
    }
    if (recoveryOwner) {
      recoveryEmployeeIdRef.current = "";
      setRecoveryEmployeeId("");
    }
    if (!recoveryOwner) {
      setContextDate("");
      setTerritoryPolicy(unrestrictedTerritoryPolicy);
      setTerritoryPosition("checking");
      setDeals([]);
    }
    sessionEpochRef.current += 1;
    sessionRef.current = result;
    setSession(result);
    setOfficeSyncError("");
    permissionPrompted.current = false;
    setScreen("today");
    setQueueDurably((items) => resumeAuthFailedOutboxRecords(
      resumeInterruptedOutboxRecords(items, result.employee.id),
      result.employee.id,
    ))
      .then(() => syncOperations())
      .catch((error) => setOfficeSyncError(error instanceof Error ? error.message : "Saved work could not resume after sign-in."));
    resumeLocationQueueAfterAuthentication(result.employee.id)
      .then(() => flushLocationQueue(result.employee.id, result.token))
      .then(() => refreshLocationCount())
      .catch(() => refreshLocationCount().catch(() => undefined));
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

  async function startWork() {
    if (!session) return;
    if (!beginFieldAction("start_work")) return;
    try {
      const permissions = await refreshPermissions();
      if (!permissions.foreground || !permissions.services) {
        Alert.alert("Location access required", "Turn on phone location and allow access while using FieldOPS before starting work.", [
          { text: "Cancel", style: "cancel" },
          { text: "Open settings", onPress: () => Linking.openSettings() },
        ]);
        return;
      }
      const point = await gps(Location.Accuracy.High);
      const capturedAt = new Date(point.timestamp).toISOString();
      setWorkState("active");
      await queueLocationObjects(session.employee.id, [point], "foreground");
      const initialRoutePoint = routeTrackPoint(point);
      if (isReliableRoutePoint(initialRoutePoint, operationsPolicy)) {
        lastCapturedRoutePointRef.current = initialRoutePoint;
      }
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
      Alert.alert("Work did not start", error instanceof Error ? error.message : "Turn on phone location and try again.");
    } finally {
      endFieldAction("start_work");
    }
  }

  async function finishWork() {
    if (!session) return;
    if (activeVisit) {
      Alert.alert("Finish the current visit", "Submit the current visit with its photo and audio note before finishing today’s work.");
      return;
    }
    if (!beginFieldAction("finish_work")) return;
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
      await stopBackgroundRouteTracking();
      await refreshBackgroundRouteStatus().catch(() => undefined);
      await flushLocationQueue(session.employee.id, session.token);
      await refreshLocationCount();
    } catch (error) {
      Alert.alert("Location needed to finish", error instanceof Error ? error.message : "Turn on phone location and try again.");
    } finally {
      endFieldAction("finish_work");
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
      Alert.alert(
        workState === "active" ? "Route recording paused" : "Start work first",
        trackingReady ? "Tap Start work before beginning a visit." : "Fix phone location before beginning a visit.",
      );
      return;
    }
    if (!beginFieldAction("start_visit")) return;
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
      Alert.alert("Visit did not start", error instanceof Error ? error.message : "Turn on phone location and try again.");
    } finally {
      endFieldAction("start_visit");
    }
  }

  async function startUnplannedVisit(customerName: string, customerAddress: string) {
    if (!session) return;
    if (activeVisit) {
      Alert.alert("Finish the current visit", "Only one visit can be in progress at a time.");
      return;
    }
    if (!workActuallyRunning) {
      Alert.alert(
        workState === "active" ? "Route recording paused" : "Start work first",
        trackingReady ? "Tap Start work before beginning a visit." : "Fix phone location before beginning a visit.",
      );
      return;
    }
    if (!beginFieldAction("start_place")) return;
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
      Alert.alert("Visit did not start", error instanceof Error ? error.message : "Turn on phone location and try again.");
    } finally {
      endFieldAction("start_place");
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
    if (!beginFieldAction("finish_visit")) return;
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
      const queuedVisit = await enqueue(`${selected.name} · ${selected.kind === "self" ? "send place report" : "complete visit"}`, {
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
      if (shouldAttemptImmediateUpload(networkOnlineRef.current)) {
        await syncOperations({ force: true, onlyId: queuedVisit.id });
      }
      const upload = queueRef.current.find((item) => item.id === queuedVisit.id);
      if (upload?.state === "confirmed") {
        setScreen("route");
        Alert.alert(
          selected.kind === "self" ? "Place report uploaded" : "Visit uploaded",
          selected.kind === "self"
            ? "The office received the GPS point, storefront photo, and voice report. It is now waiting for admin review."
            : "The office received the visit, storefront photo, voice report, and GPS evidence. It is now visible on the dashboard.",
        );
      } else {
        setScreen("sync");
        Alert.alert(
          upload?.state === "failed" ? "Upload needs attention" : "Saved on this phone",
          upload?.state === "failed"
            ? `${upload.error || "The server did not accept this visit."} The photo and voice report are still safe on this phone. Activity & Sync shows the retry action.`
            : "The visit is not on the dashboard yet. The photo and voice report are safe on this phone and Activity & Sync will send them when the server is reachable.",
        );
      }
    } catch (error) {
      Alert.alert("Visit not finished", error instanceof Error ? error.message : "Turn on phone location and try again.");
    } finally {
      endFieldAction("finish_visit");
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
    if (!beginFieldAction("save_order")) return;
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
      Alert.alert("Order not saved", error instanceof Error ? error.message : "Turn on phone location and try again.");
    } finally {
      endFieldAction("save_order");
    }
  }

  function applyDealConfirmation(item: QueueItem, confirmation: unknown) {
    const operation = item.operation;
    if (operation?.type !== "json" || !confirmation || typeof confirmation !== "object") return;
    const result = confirmation as Record<string, unknown>;
    if (operation.path === "/deals" && result.deal) {
      const deal = normalizeDeals([result.deal])[0];
      if (!deal) return;
      const localId = typeof operation.body.idempotencyKey === "string" ? operation.body.idempotencyKey : "";
      setDeals((current) => normalizeDeals([
        ...current.filter((entry) => entry.id !== localId && entry.id !== deal.id),
        deal,
      ]));
    }
  }

  async function createDeal(draft: DealDraft) {
    const customerName = draft.customerName.trim();
    const title = draft.title.trim();
    if (!customerName || !title) throw new Error("Customer and opportunity title are required.");
    if (draft.amount !== null && (!Number.isFinite(draft.amount) || draft.amount < 0)) {
      throw new Error("Enter a valid non-negative deal amount.");
    }
    const followUpDate = draft.followUpAt ? new Date(draft.followUpAt) : null;
    if (followUpDate && !Number.isFinite(followUpDate.valueOf())) throw new Error("Enter a valid follow-up date.");
    const followUpAt = followUpDate?.toISOString() ?? "";
    const idempotencyKey = operationId("deal");
    const updatedAt = new Date().toISOString();
    const deal: Deal = {
      id: idempotencyKey,
      outletId: draft.outletId,
      customerName,
      title,
      stage: draft.stage,
      amount: draft.amount,
      nextAction: draft.nextAction.trim(),
      followUpAt,
      notes: draft.notes.trim(),
      updatedAt,
    };
    await enqueue(`Deal · ${customerName}`, {
      type: "json",
      path: "/deals",
      body: {
        action: "create",
        outletId: deal.outletId,
        customerName: deal.customerName,
        title: deal.title,
        stage: deal.stage,
        amount: deal.amount,
        nextAction: deal.nextAction,
        followUpAt: deal.followUpAt,
        notes: deal.notes,
        idempotencyKey,
      },
    });
    setDeals((current) => normalizeDeals([...current, deal]));
  }

  async function updateDealStage(dealId: string, stage: DealStage) {
    const deal = deals.find((item) => item.id === dealId);
    if (!deal) throw new Error("This deal is no longer available. Update Sales and try again.");
    const staleConflictIds = queueRef.current.flatMap((item) => {
      const operation = item.operation;
      return item.state === "failed"
        && item.errorKind === "conflict"
        && operation?.type === "json"
        && operation.path === "/deals"
        && operation.body.action === "stage_update"
        && operation.body.dealId === dealId
        ? [item.id]
        : [];
    });
    const idempotencyKey = operationId("deal_stage");
    await enqueue(`Deal stage · ${deal.customerName}`, {
      type: "json",
      path: "/deals",
      body: { action: "stage_update", dealId, stage, expectedUpdatedAt: deal.updatedAt, idempotencyKey },
    });
    if (staleConflictIds.length > 0) {
      const stale = new Set(staleConflictIds);
      await setQueueDurably((items) => items.filter((item) => !stale.has(item.id))).catch(() => undefined);
    }
    setDeals((current) => current.map((item) => item.id === dealId ? {
      ...item,
      stage,
      updatedAt: new Date().toISOString(),
    } : item));
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

  function retryEverything(): Promise<void> {
    if (manualSyncPromiseRef.current) return manualSyncPromiseRef.current;
    setManualSyncing(true);
    const operation = (async () => {
      try {
        await Promise.all([
          syncOperations({ force: true }),
          session ? flushLocationQueue(session.employee.id, session.token, { force: true }) : Promise.resolve(0),
        ]);
        await refreshLocationCount();
        await refreshContext(false);
      } catch (error) {
        Alert.alert("Sync could not continue", error instanceof Error ? error.message : "Saved work could not be updated on this phone.");
      }
    })();
    manualSyncPromiseRef.current = operation;
    return operation.finally(() => {
      if (manualSyncPromiseRef.current === operation) {
        manualSyncPromiseRef.current = null;
        setManualSyncing(false);
      }
    });
  }

  async function signOut() {
    const authenticatedSession = sessionRef.current;
    if (!authenticatedSession) return;
    if (recording) {
      Alert.alert("Stop the recording first", "Stop and save the audio note before signing out.");
      return;
    }
    await stopBackgroundRouteTracking();
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
            operationsPolicy,
            contextDate,
            serverActivity,
            deals,
            lastSyncAt,
          } satisfies PersistedState)],
        ]);
      } catch {
        await refreshBackgroundRouteStatus().catch(() => undefined);
        Alert.alert("Could not protect saved work", "FieldOPS could not update local storage. Please try again before signing out.");
        return;
      }
      await revokeMobileSession(authenticatedSession);
      await clearSecureMobileSession().catch(() => undefined);
      recoveryEmployeeIdRef.current = employeeId;
      setRecoveryEmployeeId(employeeId);
      sessionEpochRef.current += 1;
      sessionRef.current = null;
      syncPromiseRef.current = null;
      fieldActionRef.current = null;
      lastCapturedRoutePointRef.current = null;
      setSession(null);
      setFieldAction(null);
      setLocationPending(0);
      setLocationRejected(0);
      setLocationSyncError("");
      setBackgroundRoute(defaultBackgroundRouteStatus);
      networkOnlineRef.current = null;
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
        operationsPolicy: defaultOperationsPolicy,
        contextDate: "",
        serverActivity: [],
        deals: [],
        lastSyncAt: "",
      } satisfies PersistedState));
    } catch {
      await refreshBackgroundRouteStatus().catch(() => undefined);
      Alert.alert("Could not sign out safely", "FieldOPS could not update local storage. Please try again.");
      return;
    }
    await revokeMobileSession(authenticatedSession);
    await clearSecureMobileSession().catch(() => undefined);
    sessionEpochRef.current += 1;
    sessionRef.current = null;
    syncPromiseRef.current = null;
    fieldActionRef.current = null;
    lastCapturedRoutePointRef.current = null;
    recoveryEmployeeIdRef.current = "";
    setSession(null);
    setFieldAction(null);
    setRecoveryEmployeeId("");
    setOutlets([]);
    setSelectedId("");
    setWorkState("not_started");
    setActiveVisit(null);
    setLocationPending(0);
    setLocationRejected(0);
    setLocationSyncError("");
    setBackgroundRoute(defaultBackgroundRouteStatus);
    networkOnlineRef.current = null;
    setNetworkOnline(null);
    setRefreshing(false);
    setTerritoryPolicy(unrestrictedTerritoryPolicy);
    setOperationsPolicy(defaultOperationsPolicy);
    setContextDate("");
    setTerritoryPosition("checking");
    setServerActivity([]);
    setDeals([]);
    setLastSyncAt("");
    setOfficeSyncError("");
    setScreen("today");
  }

  if (!hydrated) {
    return <SafeAreaView className="flex-1 bg-paper" edges={["top", "bottom"]}>
      <StatusBar barStyle="dark-content" />
      <View className="flex-1 items-center justify-center px-6">
        <LogoMark size={72} />
        <Text className="mt-5 text-xl font-semibold text-ink">Loading FieldOPS…</Text>
      </View>
    </SafeAreaView>;
  }
  if (!session) return <Login onSubmit={signIn} recoveryRequired={Boolean(recoveryEmployeeId)} />;
  if (!permissionChecked) {
    return <PermissionGate
      state={permissionState}
      backgroundRoute={backgroundRoute}
      busy={permissionBusy}
      onRequest={requestLocationPermission}
      onSettings={() => Linking.openSettings()}
      onLogout={signOut}
    />;
  }

  return <SafeAreaView className="flex-1 bg-field" edges={["top"]}>
    <StatusBar barStyle="light-content" />
    <KeyboardAvoidingView className="flex-1 bg-paper" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView ref={contentScrollRef} className="flex-1" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: screen === "today" ? 420 : 150, backgroundColor: "#F6F1ED", experimental_backgroundImage: "linear-gradient(180deg, #CB183D 0%, #CB183D 45%, #EDBBC5 75%, #F6F1ED 100%)" }} />
        <View className="gap-4 px-5 pb-9 pt-5">
          <Header
            screen={screen}
            pending={pending}
            online={networkOnline}
            syncing={syncing}
            needsAttention={needsSyncAttention}
            refreshing={refreshing}
            onSync={() => setScreen("sync")}
            onRefresh={() => refreshContext()}
          />
          {screen !== "sync" && screen !== "deals" && screen !== "profile" && <TerritoryBanner
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
            sessionAction={fieldAction === "start_work" ? "starting" : fieldAction === "finish_work" ? "finishing" : null}
            visitStarting={fieldAction === "start_visit"}
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
            starting={fieldAction === "start_place"}
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
            action={fieldAction === "start_visit" ? "starting" : fieldAction === "finish_visit" ? "finishing" : null}
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
            saving={fieldAction === "save_order"}
            onSubmit={createOrder}
          />}
          {screen === "deals" && <SalesPipeline
            deals={deals}
            outlets={outlets}
            queue={employeeQueue}
            refreshing={refreshing}
            onRefresh={() => refreshContext()}
            onCreateDeal={createDeal}
            onUpdateDealStage={updateDealStage}
          />}
          {screen === "sync" && <SyncQueue
            queue={employeeQueue}
            locationPending={locationPending}
            locationRejected={locationRejected}
            locationSyncError={locationSyncError}
            activity={serverActivity}
            online={networkOnline}
            lastSyncAt={lastSyncAt}
            officeSyncError={officeSyncError}
            checking={manualSyncing || refreshing}
            onRetry={retryEverything}
            onRetryItem={retryQueueItem}
            onClearRejectedLocations={removeRejectedRoutePoints}
          />}
          {screen === "profile" && <Profile
            session={session}
            workState={workState}
            trackingReady={trackingReady}
            routePolicy={operationsPolicy}
            backgroundRoute={backgroundRoute}
            backgroundRouteBusy={backgroundRouteBusy}
            pending={pending}
            territoryMessage={territoryMessage}
            onEnableBackgroundRoute={enableBackgroundRoute}
            onDisableBackgroundRoute={disableBackgroundRoute}
            onOpenSettings={() => Linking.openSettings()}
            onLogout={signOut}
          />}
        </View>
      </ScrollView>
      <SafeAreaView edges={["bottom"]} className="bg-paper"><Nav screen={screen} pending={pending} setScreen={setScreen} /></SafeAreaView>
    </KeyboardAvoidingView>
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
  return <SafeAreaView className="flex-1 bg-field" edges={["top"]}>
    <StatusBar barStyle="light-content" />
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, backgroundColor: "#F6F1ED" }}>
      <View className="flex-1 justify-center gap-8 px-6 py-10" style={{ experimental_backgroundImage: "linear-gradient(180deg, #CB183D 0%, #CB183D 50%, #F6F1ED 90%)" }}>
        <View className="items-start">
          <LogoMark size={76} />
          <Text className="mt-5 text-xs font-semibold tracking-[1.4px] text-[#FFE5EB]">YOUSUF RICE · FIELDOPS</Text>
          <Text className="mt-3 text-[34px] font-bold leading-10 text-white">A better day{"\n"}in the field.</Text>
          <Text className="mt-3 max-w-[360px] leading-6 text-[#FFF1F4]">
            Your visits, customers, and orders. All in one place, even when you’re offline.
          </Text>
        </View>
        <View className="gap-3.5 rounded-[24px] border border-white/20 bg-white p-5">
          <Text className="text-2xl font-bold text-ink">Welcome back</Text>
          <Text className="mb-2 text-sm leading-5 text-muted">Sign in to get your day started.</Text>
          {recoveryRequired && <View className="rounded-[9px] bg-[#FFF4D6] p-3">
            <Text className="font-bold leading-5 text-[#6B4D00]">
              Saved work is waiting on this phone. Sign in with the same employee account to recover and upload it.
            </Text>
          </View>}
          <TextInput
            accessibilityLabel="Work email"
            className="min-h-14 rounded-xl border border-line bg-[#FAF7F5] px-4 text-base text-ink"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            placeholder="Your work email"
            placeholderTextColor="#75686B"
          />
          <TextInput
            accessibilityLabel="Password"
            className="min-h-14 rounded-xl border border-line bg-[#FAF7F5] px-4 text-base text-ink"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            placeholder="Your password"
            placeholderTextColor="#75686B"
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
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

function PermissionGate({
  state,
  backgroundRoute,
  busy,
  onRequest,
  onSettings,
  onLogout,
}: {
  state: PermissionState;
  backgroundRoute: BackgroundRouteStatus;
  busy: boolean;
  onRequest: () => void;
  onSettings: () => void;
  onLogout: () => void;
}) {
  return <SafeAreaView className="flex-1 bg-paper" edges={["top", "bottom"]}>
    <StatusBar barStyle="dark-content" />
    <ScrollView className="flex-1">
      <View className="min-h-screen justify-center gap-4 px-6 py-10">
        <LogoMark size={64} />
        <Eyebrow>ONE-TIME SETUP</Eyebrow>
        <ScreenTitle>Turn on location</ScreenTitle>
        <BodyText>
          Phone location proves you are at the customer when you check in or mark a new place. Your manager’s work-area map is checked separately after this setup.
        </BodyText>
        <View className="rounded-2xl border border-line bg-white px-4">
          <PermissionRow label="Allow FieldOPS location" ready={state.foreground} />
          <PermissionRow label="Phone location switched on" ready={state.services} />
          <PermissionRow label="Route through screen lock" ready={backgroundRoute.enabled && backgroundRoute.permission === "granted"} later />
          <PermissionRow label="Camera for storefront photo" ready={state.camera} later />
          <PermissionRow label="Microphone for voice report" ready={state.microphone} later />
        </View>
        <Button label={busy ? "Checking…" : "Allow location & continue"} disabled={busy} onPress={onRequest} />
        <Text className="text-xs leading-5 text-muted">Screen-lock route continuity is optional. Set it up later in Profile; choosing no does not block field work.</Text>
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
  online,
  syncing,
  needsAttention,
  refreshing,
  onSync,
  onRefresh,
}: {
  screen: Screen;
  pending: number;
  online: boolean | null;
  syncing: boolean;
  needsAttention: number;
  refreshing: boolean;
  onSync: () => void;
  onRefresh: () => void;
}) {
  const syncLabel = needsAttention > 0
    ? "Check"
    : online === false
      ? pending > 0 ? `${pending} safe` : "Offline"
      : syncing
        ? "Sending"
        : pending > 0
          ? `${pending} queued`
          : online === null ? "Checking" : "Live";
  const syncBackgroundClass = needsAttention > 0
    ? "bg-[#FCEDEA]"
    : online === false
      ? "bg-[#FFF1D0]"
      : syncing || online === null
        ? "bg-[#F8E9EE]"
        : pending > 0 ? "bg-[#FFF1D0]" : "bg-[#DFF3E9]";
  const syncTextClass = needsAttention > 0
    ? "text-danger"
    : online === false
      ? "text-[#805C00]"
      : syncing || online === null
        ? "text-field"
        : pending > 0 ? "text-[#805C00]" : "text-success";
  return <View className="gap-5 pb-2">
    <View className="flex-row items-center gap-2">
    <View className="min-w-0 flex-1 flex-row items-center gap-2.5">
      <LogoMark size={50} />
      <View className="min-w-0 flex-1">
        <Text className="text-[19px] font-bold tracking-tight text-white">FieldOPS</Text>
        <Text className="mt-0.5 text-[11px] font-medium text-[#FFE4EB]">Yousuf Rice</Text>
      </View>
    </View>
    <View className="flex-row gap-1.5">
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Refresh today’s assignments and sales area"
        accessibilityState={{ disabled: refreshing }}
        className="min-h-11 min-w-11 items-center justify-center rounded-full border border-white/25 bg-white/15 px-2"
        onPress={onRefresh}
        disabled={refreshing}
      >
        <Text className="text-xl font-semibold text-white">{refreshing ? "…" : "↻"}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open activity. Automatic upload status: ${syncLabel}`}
        className={classes("min-h-11 min-w-11 items-center justify-center rounded-full px-2", syncBackgroundClass)}
        onPress={onSync}
      >
        <Text className={classes("text-[11px] font-black", syncTextClass)}>{syncLabel}</Text>
      </TouchableOpacity>
    </View>
    </View>
    {screen === "today" && <View><Text accessibilityRole="header" className="text-[28px] font-bold tracking-tight text-white">Your field day</Text><Text className="mt-1 text-xs font-medium text-[#FFF1F4]">{new Date().toLocaleDateString("en-PK", { weekday: "long", day: "numeric", month: "long" })}</Text></View>}
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
  if (allowed) return <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Location ready. ${message}. Check current location again.`} className="min-h-11 flex-row items-center justify-between gap-2 rounded-xl bg-white/95 px-3.5 py-2.5" onPress={onCheck}>
    <View className="flex-1 flex-row items-center gap-2"><View className="h-2 w-2 rounded-full bg-success" /><Text className="flex-1 text-xs font-semibold text-success">{policy.mode === "unrestricted" ? "Location ready · You can work here" : "Inside your work area"}</Text></View><Text className="text-xs font-semibold text-muted">Check ↻</Text>
  </TouchableOpacity>;
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
    <Text className="mt-2 leading-5 text-[#75686B]">{detail}</Text>
    {lastCheck && policyReady && !permissionProblem && <Text className="mt-2 text-[11px] font-bold text-[#607063]">
      Checked {new Date(lastCheck.checkedAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })} · ±{lastCheck.accuracy} m · smaller is better
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
  sessionAction,
  visitStarting,
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
  sessionAction: "starting" | "finishing" | null;
  visitStarting: boolean;
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
        ? "Route recording paused"
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
    <View className="flex-row gap-3">
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`View ${total} assigned visits`} onPress={onRoute} className="flex-1 justify-between rounded-[22px] bg-field p-5">
        <View className="self-end rounded-xl bg-white/15 p-2.5"><MobileIcon name="route" color="#FFFFFF" /></View>
        <View><Text className="text-[44px] font-bold leading-[52px] text-white">{total}</Text><Text className="mt-1 text-sm font-medium text-[#FFE4EB]">Assigned visits</Text></View>
        <Text className="mt-5 text-xs font-semibold text-white">View today’s plan ↗</Text>
      </TouchableOpacity>
      <View className="flex-1 gap-3">
        <View className="flex-row items-center justify-between gap-2 rounded-[22px] bg-white p-4"><View className="flex-1"><Text className="text-[28px] font-bold text-ink">{completed}</Text><Text className="mt-1 text-xs text-muted">Completed</Text></View><View className="rounded-xl bg-[#E5F2E9] p-2.5"><MobileIcon name="sync" color="#248564" /></View></View>
        <View className="flex-row items-center justify-between gap-2 rounded-[22px] bg-white p-4"><View className="flex-1"><Text className="text-[28px] font-bold text-ink">{selfVisitCount}</Text><Text className="mt-1 text-xs text-muted">New places</Text></View><View className="rounded-xl bg-[#FBE9D3] p-2.5"><MobileIcon name="today" color="#AA6B18" /></View></View>
      </View>
    </View>
    <View className={classes(
      "gap-4 rounded-[22px] border bg-white p-5",
      workState === "active" && !trackingReady ? "border-danger" : "border-line",
    )}>
      <View className="flex-row items-start gap-3"><View className="flex-1"><Text className="text-lg font-bold text-ink">{title}</Text><Text className="mt-1 text-xs leading-5 text-muted">{detail}</Text></View><View className={classes("mt-1.5 h-2.5 w-2.5 rounded-full", running ? "bg-success" : "bg-gold")} /></View>
      {workState !== "active" && <Button label={sessionAction === "starting" ? "Starting…" : workState === "finished" ? "Start again" : "Start work"} disabled={sessionAction !== null} onPress={onStartWork} />}
      {workState === "active" && trackingReady && <GhostButton dark label={sessionAction === "finishing" ? "Finishing…" : "Finish session"} disabled={sessionAction !== null} onPress={onFinishWork} />}
      {workState === "active" && !trackingReady && <Button label="Fix location" onPress={onFixGps} />}
    </View>

    <SectionTitle>Up next</SectionTitle>
    {nextOutlet ? <View className="overflow-hidden rounded-[22px] bg-[#541C2A] p-5" style={{ experimental_backgroundImage: "linear-gradient(130deg, #682238, #3D1E25)" }}>
      <Text className="text-[10px] font-semibold tracking-wider text-[#F7B8CA]">NEXT ASSIGNED VISIT</Text>
      <Text className="mt-2.5 text-2xl font-bold text-white">{nextOutlet.name}</Text>
      <Text className="mt-1.5 text-sm leading-5 text-[#F2D7DE]">{nextOutlet.address}</Text>
      <View className="mt-5 flex-row flex-wrap gap-2.5">
        <Button label={visitStarting ? "Finding location…" : "Check in"} disabled={!actionEnabled || visitStarting} onPress={onStartVisit} />
        <GhostButton label="All visits" onPress={onRoute} />
      </View>
      {!fieldActionsAllowed && <Text className="mt-3 leading-5 text-[#FFF1D0]">{territoryMessage}</Text>}
      <Text className="mt-3 text-xs leading-5 text-[#F2D7DE]">Check in within {GEOFENCE_METERS} m of the shop.</Text>
    </View> : <EmptyState title="No assigned visits waiting" body="You can still mark a new customer place while your work session and location are ready." />}

    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Mark a new customer place"
      accessibilityState={{ disabled: !actionEnabled }}
      className={classes(
        "min-h-24 flex-row items-center justify-between gap-3 rounded-[22px] border border-line bg-white p-5",
        !actionEnabled && "opacity-45",
      )}
      disabled={!actionEnabled}
      onPress={onNewVisit}
    >
      <View className="flex-1">
        <Text className="text-lg font-bold text-ink">Add a customer visit</Text>
        <Text className="mt-1 text-xs leading-5 text-muted">Mark the location, add a photo & voice report.</Text>
      </View>
      <View className="h-12 w-12 items-center justify-center rounded-full bg-field"><Text className="text-[28px] font-medium text-white">+</Text></View>
    </TouchableOpacity>

    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel="Take a new order"
      accessibilityState={{ disabled: !fieldActionsAllowed }}
      className={classes(
        "min-h-20 flex-row items-center justify-between rounded-[22px] border border-line bg-white p-5",
        !fieldActionsAllowed && "opacity-45",
      )}
      disabled={!fieldActionsAllowed}
      onPress={onOrder}
    >
      <View>
        <Text className="text-lg font-bold text-ink">Take an order</Text>
        <Text className="mt-1 text-xs text-muted">Record a customer’s rice order.</Text>
      </View>
      <View className="rounded-xl bg-[#FBE9D3] p-3"><MobileIcon name="deals" color="#AA6B18" /></View>
    </TouchableOpacity>

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
    {assigned.map((outlet, index) => <View key={outlet.id} className="gap-3 rounded-[20px] border border-line bg-white p-4">
      <View className="flex-row items-center gap-3"><View className="h-10 w-10 items-center justify-center rounded-xl bg-[#FBE7ED]"><Text className="font-bold text-field">{index + 1}</Text></View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`Open ${outlet.name}`}
        className="min-h-12 flex-1 justify-center"
        onPress={() => onSelect(outlet.id)}
      >
        <Text className="font-extrabold text-ink">{outlet.name}</Text>
        <Text className="mt-1 text-xs text-muted">{outlet.address}</Text>
      </TouchableOpacity>
      <Status status={outlet.status} /></View>
      <View className="flex-row justify-end gap-2 border-t border-line pt-3">
        <CompactButton label="Earlier" disabled={index === 0} onPress={() => onMove(outlet.id, -1)} />
        <CompactButton label="Later" disabled={index === assigned.length - 1} onPress={() => onMove(outlet.id, 1)} />
      </View>
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
  starting,
  onSubmit,
  onBack,
}: {
  running: boolean;
  accessAllowed: boolean;
  territoryMessage: string;
  starting: boolean;
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
        placeholderTextColor="#75686B"
        autoFocus
      />
      <InputLabel>ADDRESS OR LANDMARK · OPTIONAL</InputLabel>
      <TextInput
        accessibilityLabel="Customer address or area"
        className="min-h-12 rounded-[9px] border border-line bg-white px-3 text-base text-ink"
        value={customerAddress}
        onChangeText={setCustomerAddress}
        placeholder="Example: Tariq Road, near the pharmacy"
        placeholderTextColor="#75686B"
      />
      <Button
        label={busy || starting ? "Marking this spot…" : "Mark this spot & start report"}
        disabled={busy || starting || !enabled}
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
  action,
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
  action: "starting" | "finishing" | null;
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
      {!selfCreated && !activeVisit && !submissionPending && outlet.status !== "completed" && <Button label={action === "starting" ? "Finding visit GPS…" : "Check in at this shop"} disabled={!accessAllowed || action !== null} onPress={onStart} />}
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
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
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
        placeholderTextColor="#75686B"
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
          <Text className="font-extrabold text-[#205E49]">Voice report saved on this phone</Text>
          <Text className="mt-1 text-xs text-[#4F655C]">Listen once before uploading if needed.</Text>
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
      {(photo || audio) && <InfoNotice
        title={photo && audio ? "Evidence ready to upload" : "Evidence is still incomplete"}
        body={photo && audio
          ? `The photo and voice report are currently on this phone. Tap ${selfCreated ? "Send for admin review" : "Complete visit"} and wait for “uploaded” before expecting them on the dashboard. The office copy is automatically deleted after 7 days.`
          : "Captured evidence stays on this phone until both items are ready and the completed visit is accepted by the server."}
      />}
      <Button label={action === "finishing" ? "Saving & uploading visit…" : selfCreated ? "Send for admin review" : "Complete visit"} disabled={!accessAllowed || !photo || !audio || recording || action !== null} onPress={onFinish} />
      <DangerOutlineButton label={selfCreated ? "Discard marked-place draft" : "Discard visit draft"} disabled={action !== null} onPress={onDiscard} />
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
  saving,
  onSubmit,
}: {
  outlets: Outlet[];
  accessAllowed: boolean;
  territoryMessage: string;
  saving: boolean;
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
    <BodyText>The current GPS point is saved. If sales areas are assigned, orders are enabled only inside one of them.</BodyText>
    {!accessAllowed && <WarningNotice title="Orders unavailable here" body={territoryMessage} />}
    <View className="gap-3 rounded-[14px] border border-line bg-white p-[18px]">
      <InputLabel>ASSIGNED VISIT · OPTIONAL</InputLabel>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
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
        placeholderTextColor="#75686B"
        multiline
        textAlignVertical="top"
      />
      <View className="flex-row justify-between border-t border-line pt-3.5">
        <Text className="font-bold text-muted">Order total</Text>
        <Text className="text-lg font-black text-ink">PKR {total.toLocaleString()}</Text>
      </View>
      <Button
        label={busy || saving ? "Saving order…" : "Save order"}
        disabled={busy || saving || !accessAllowed}
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

function SalesPipeline({
  deals,
  outlets,
  queue,
  refreshing,
  onRefresh,
  onCreateDeal,
  onUpdateDealStage,
}: {
  deals: Deal[];
  outlets: Outlet[];
  queue: QueueItem[];
  refreshing: boolean;
  onRefresh: () => void;
  onCreateDeal: (draft: DealDraft) => Promise<void>;
  onUpdateDealStage: (dealId: string, stage: DealStage) => Promise<void>;
}) {
  const [creatingDeal, setCreatingDeal] = useState(false);
  const [dealBusy, setDealBusy] = useState(false);
  const [updatingDealId, setUpdatingDealId] = useState("");
  const [stageEditorId, setStageEditorId] = useState("");
  const [dealOutletId, setDealOutletId] = useState("");
  const [dealCustomer, setDealCustomer] = useState("");
  const [dealTitle, setDealTitle] = useState("");
  const [dealStage, setDealStage] = useState<DealStage>("lead");
  const [dealAmount, setDealAmount] = useState("");
  const [dealNextAction, setDealNextAction] = useState("");
  const [dealFollowUpDate, setDealFollowUpDate] = useState("");
  const [dealNotes, setDealNotes] = useState("");

  const pendingDealItems = useMemo(() => queue.filter((item) => (
    item.state !== "confirmed"
    && item.operation?.type === "json"
    && item.operation.path === "/deals"
  )), [queue]);
  const optimisticDealItems = useMemo(() => pendingDealItems.filter((item) => !(
    item.state === "failed" && item.retryable === false
  )), [pendingDealItems]);

  const pendingDealCreateIds = useMemo(() => new Set(optimisticDealItems.flatMap((item) => {
    const operation = item.operation;
    if (operation?.type !== "json" || operation.path !== "/deals" || operation.body.action !== "create") return [];
    const key = typeof operation.body.idempotencyKey === "string" ? operation.body.idempotencyKey : "";
    return key ? [key] : [];
  })), [optimisticDealItems]);

  const pendingStageDealIds = useMemo(() => new Set(optimisticDealItems.flatMap((item) => {
    const operation = item.operation;
    if (operation?.type !== "json" || operation.path !== "/deals" || operation.body.action !== "stage_update") return [];
    const dealId = typeof operation.body.dealId === "string" ? operation.body.dealId : "";
    return dealId ? [dealId] : [];
  })), [optimisticDealItems]);

  const stageConflicts = useMemo(() => new Map(pendingDealItems.flatMap((item) => {
    const operation = item.operation;
    if (item.state !== "failed"
      || item.errorKind !== "conflict"
      || operation?.type !== "json"
      || operation.path !== "/deals"
      || operation.body.action !== "stage_update") return [];
    const dealId = typeof operation.body.dealId === "string" ? operation.body.dealId : "";
    const expectedUpdatedAt = typeof operation.body.expectedUpdatedAt === "string" ? operation.body.expectedUpdatedAt : "";
    return dealId ? [[dealId, expectedUpdatedAt] as const] : [];
  })), [pendingDealItems]);

  const localDealIds = useMemo(() => new Set(queue.flatMap((item) => {
    const operation = item.operation;
    if (operation?.type !== "json" || operation.path !== "/deals" || operation.body.action !== "create") return [];
    const key = typeof operation.body.idempotencyKey === "string" ? operation.body.idempotencyKey : "";
    return key ? [key] : [];
  })), [queue]);

  const visibleDeals = useMemo(() => {
    const combined = new Map(deals.map((deal) => [deal.id, deal]));
    const pendingStages = new Map<string, DealStage>();
    for (const item of optimisticDealItems) {
      const operation = item.operation;
      if (operation?.type !== "json" || operation.path !== "/deals") continue;
      if (operation.body.action === "create") {
        const id = typeof operation.body.idempotencyKey === "string" ? operation.body.idempotencyKey : "";
        if (!id || combined.has(id)) continue;
        const pending = normalizeDeals([{ ...operation.body, id, updatedAt: item.createdAt }])[0];
        if (pending) combined.set(id, pending);
      }
      if (operation.body.action === "stage_update") {
        const id = typeof operation.body.dealId === "string" ? operation.body.dealId : "";
        const stage = typeof operation.body.stage === "string" ? operation.body.stage : "";
        if (id && isDealStage(stage)) pendingStages.set(id, stage);
      }
    }
    return normalizeDeals([...combined.values()].map((deal) => (
      pendingStages.has(deal.id) ? { ...deal, stage: pendingStages.get(deal.id) } : deal
    )));
  }, [deals, optimisticDealItems]);
  const stageName = (stage: string) => stage ? `${stage[0]?.toUpperCase() ?? ""}${stage.slice(1)}` : "Lead";
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.valueOf())
      ? date.toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })
      : "Not scheduled";
  };
  const validFollowUp = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day!));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
  };

  return <>
    <View className="flex-row items-start justify-between gap-3">
      <View className="flex-1">
        <Eyebrow>SALES PIPELINE</Eyebrow>
        <ScreenTitle>Customer deals</ScreenTitle>
        <BodyText>Record customer intent, keep the next action clear, and move each opportunity forward.</BodyText>
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Update customer deals"
        accessibilityState={{ disabled: refreshing }}
        className="min-h-12 min-w-20 items-center justify-center rounded-xl border border-field bg-[#FFF4F7] px-3"
        onPress={onRefresh}
        disabled={refreshing}
      >
        <Text className="text-xs font-black text-field">{refreshing ? "Updating…" : "Update"}</Text>
      </TouchableOpacity>
    </View>

    <View className="mt-1 flex-row items-center justify-between gap-3">
      <View className="flex-1">
        <SectionTitle>Customer deals</SectionTitle>
        <Text className="mt-1 text-xs leading-5 text-muted">{visibleDeals.length} active and completed {visibleDeals.length === 1 ? "opportunity" : "opportunities"}</Text>
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={creatingDeal ? "Close new deal form" : "Create a new deal"}
        className="min-h-12 items-center justify-center rounded-xl bg-gold px-4"
        onPress={() => setCreatingDeal((value) => !value)}
      ><Text className="font-black text-ink">{creatingDeal ? "Close" : "New deal"}</Text></TouchableOpacity>
    </View>

    {creatingDeal && <View className="gap-3 rounded-2xl border border-[#D8A629] bg-[#FFFAEB] p-4">
      <InputLabel>LINKED VISIT · OPTIONAL</InputLabel>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        <Choice label="No linked visit" selected={!dealOutletId} onPress={() => setDealOutletId("")} />
        {outlets.map((outlet) => <Choice
          key={outlet.id}
          label={outlet.name}
          selected={dealOutletId === outlet.id}
          onPress={() => {
            setDealOutletId(outlet.id);
            if (!dealCustomer.trim()) setDealCustomer(outlet.name);
          }}
        />)}
      </View>
      <FieldInput label="Customer or shop" value={dealCustomer} onChangeText={setDealCustomer} placeholder="Customer or shop · required" />
      <FieldInput label="Opportunity title" value={dealTitle} onChangeText={setDealTitle} placeholder="Example: Monthly rice supply" />
      <InputLabel>STAGE</InputLabel>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
        {dealStages.map((stage) => <Choice key={stage} label={stageName(stage)} selected={dealStage === stage} onPress={() => setDealStage(stage)} />)}
      </View>
      <FieldInput label="Expected amount" value={dealAmount} onChangeText={setDealAmount} placeholder="PKR · optional" keyboardType="decimal-pad" />
      <FieldInput label="Next action" value={dealNextAction} onChangeText={setDealNextAction} placeholder="Example: Send price list" />
      <FieldInput label="Follow-up date" value={dealFollowUpDate} onChangeText={setDealFollowUpDate} placeholder="YYYY-MM-DD · optional" />
      <TextInput
        accessibilityLabel="Deal notes"
        className="min-h-[88px] rounded-xl border border-line bg-white px-3 py-3 text-base text-ink"
        value={dealNotes}
        onChangeText={setDealNotes}
        placeholder="Decision maker, requirements, risks, or useful context"
        placeholderTextColor="#75686B"
        maxLength={2_000}
        multiline
        textAlignVertical="top"
      />
      <Button
        label={dealBusy ? "Saving deal…" : "Save deal"}
        disabled={dealBusy || !dealCustomer.trim() || !dealTitle.trim()}
        onPress={() => {
          const amount = dealAmount.trim() ? Number(dealAmount) : null;
          if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
            Alert.alert("Check the amount", "Enter a valid non-negative amount, or leave it blank.");
            return;
          }
          if (dealFollowUpDate.trim() && !validFollowUp(dealFollowUpDate.trim())) {
            Alert.alert("Check the follow-up date", "Use a real date in YYYY-MM-DD format.");
            return;
          }
          const followUpAt = dealFollowUpDate.trim()
            ? new Date(`${dealFollowUpDate.trim()}T09:00:00+05:00`).toISOString()
            : "";
          setDealBusy(true);
          onCreateDeal({
            outletId: dealOutletId,
            customerName: dealCustomer.trim(),
            title: dealTitle.trim(),
            stage: dealStage,
            amount,
            nextAction: dealNextAction.trim(),
            followUpAt,
            notes: dealNotes.trim(),
          }).then(() => {
            setDealOutletId("");
            setDealCustomer("");
            setDealTitle("");
            setDealStage("lead");
            setDealAmount("");
            setDealNextAction("");
            setDealFollowUpDate("");
            setDealNotes("");
            setCreatingDeal(false);
          }).catch((error) => {
            Alert.alert("Deal not saved", error instanceof Error ? error.message : "Try again.");
          }).finally(() => setDealBusy(false));
        }}
      />
    </View>}

    {visibleDeals.length === 0
      ? <EmptyState title="No deals yet" body="Create a deal when a customer shows buying intent, then keep its next action and stage current." />
      : visibleDeals.map((deal) => {
        const pendingCreate = pendingDealCreateIds.has(deal.id);
        const conflictVersion = stageConflicts.get(deal.id);
        const conflictRefreshed = Boolean(conflictVersion && deal.updatedAt && conflictVersion !== deal.updatedAt);
        const pendingStage = pendingStageDealIds.has(deal.id) || Boolean(conflictVersion && !conflictRefreshed);
        const localDeal = localDealIds.has(deal.id);
        const knownStage = isDealStage(deal.stage) ? deal.stage : null;
        const followUpStatus = dealFollowUpStatus(deal.followUpAt, deal.stage);
        return <View key={deal.id} className="gap-3 rounded-2xl border border-line bg-white p-4">
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1">
              <Text className="text-lg font-black text-ink">{deal.title}</Text>
              <Text className="mt-1 font-bold text-muted">{deal.customerName}</Text>
            </View>
            <View className={classes("rounded-full px-3 py-1.5", deal.stage === "won" ? "bg-[#DFF3E9]" : deal.stage === "lost" ? "bg-[#FCEDEA]" : "bg-[#F8E9EE]")}>
              <Text className={classes("text-[10px] font-black uppercase tracking-wider", deal.stage === "won" ? "text-success" : deal.stage === "lost" ? "text-danger" : "text-field")}>{stageName(deal.stage)}</Text>
            </View>
          </View>
          <View className="flex-row justify-between border-y border-line py-3">
            <View><Text className="text-[10px] font-black uppercase tracking-wider text-muted">VALUE</Text><Text className="mt-1 font-black text-ink">{deal.amount === null ? "Not entered" : `PKR ${deal.amount.toLocaleString("en-PK")}`}</Text></View>
            <View className="items-end">
              <Text className="text-[10px] font-black uppercase tracking-wider text-muted">FOLLOW UP</Text>
              <Text className={classes("mt-1 font-black", followUpStatus === "Overdue" ? "text-danger" : followUpStatus ? "text-[#9A6700]" : "text-ink")}>
                {followUpStatus || formatDate(deal.followUpAt)}
              </Text>
              {followUpStatus ? <Text className="mt-0.5 text-[10px] font-bold text-muted">{formatDate(deal.followUpAt)}</Text> : null}
            </View>
          </View>
          {deal.nextAction ? <Text className="leading-5 text-ink"><Text className="font-black">Next:</Text> {deal.nextAction}</Text> : null}
          {deal.notes ? <Text className="text-xs leading-5 text-muted">{deal.notes}</Text> : null}
          {conflictVersion && <InfoNotice
            title={conflictRefreshed ? "Stage changed at the office" : "Update this deal first"}
            body={conflictRefreshed
              ? "The latest office version is shown. Choose the stage again to replace the stale saved change."
              : "Tap Update at the top while online, then choose the stage again."}
          />}
          {localDeal ? <InfoNotice title={pendingCreate ? "Deal saved on this phone" : "Deal reached the office"} body="Stage changes will unlock after the official deal record downloads." /> : <>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={conflictVersion && !conflictRefreshed
                ? `Update Sales before changing stage for ${deal.title}`
                : pendingStage
                  ? `Stage change for ${deal.title} is waiting to sync`
                  : `Change stage for ${deal.title}`}
              accessibilityState={{ disabled: pendingStage }}
              className="min-h-12 items-center justify-center rounded-xl border border-field bg-[#FFF4F7] px-3"
              disabled={pendingStage}
              onPress={() => setStageEditorId((current) => current === deal.id ? "" : deal.id)}
            ><Text className="font-black text-field">{conflictVersion && !conflictRefreshed ? "Update Sales to continue" : pendingStage ? "Stage waiting to sync" : stageEditorId === deal.id ? "Close stages" : conflictVersion ? "Choose stage again" : "Change stage"}</Text></TouchableOpacity>
            {!pendingStage && stageEditorId === deal.id && <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
              {dealStages.map((stage) => <Choice
                key={stage}
                label={stageName(stage)}
                selected={knownStage === stage}
                onPress={() => {
                  if (stage === knownStage || updatingDealId) return;
                  setUpdatingDealId(deal.id);
                  onUpdateDealStage(deal.id, stage).then(() => {
                    setStageEditorId("");
                  }).catch((error) => {
                    Alert.alert("Stage not saved", error instanceof Error ? error.message : "Try again.");
                  }).finally(() => setUpdatingDealId("") );
                }}
              />)}
              {updatingDealId === deal.id && <Text className="w-full text-xs font-bold text-muted">Saving stage safely…</Text>}
            </View>}
          </>}
        </View>;
      })}
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
  officeSyncError,
  checking,
  onRetry,
  onRetryItem,
  onClearRejectedLocations,
}: {
  queue: QueueItem[];
  locationPending: number;
  locationRejected: number;
  locationSyncError: string;
  activity: ServerActivity[];
  online: boolean | null;
  lastSyncAt: string;
  officeSyncError: string;
  checking: boolean;
  onRetry: () => void;
  onRetryItem: (id: string) => void;
  onClearRejectedLocations: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "places" | "sales">("all");
  const pendingOperations = queue.filter((item) => item.state !== "confirmed");
  const failed = pendingOperations.filter((item) => item.state === "failed").length + locationRejected + (locationSyncError ? 1 : 0) + (officeSyncError ? 1 : 0);
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
      <BodyText>See recent field work, what reached the office, and the latest admin decisions on new places.</BodyText>
    </View>
    <View className="overflow-hidden rounded-2xl bg-ink p-5">
      <View className="flex-row items-start justify-between gap-4">
        <View className="flex-1">
          <Text className="text-xs font-black uppercase tracking-widest text-[#C6AFB8]">
            {online === null ? "CHECKING CONNECTION" : online ? "ONLINE · AUTO SYNC ON" : "NO INTERNET · AUTO RETRY ON"}
          </Text>
          <Text className="mt-2 text-2xl font-black text-white">{syncTitle}</Text>
          <Text className="mt-2 leading-5 text-[#ECD7DD]">
            {authFailed
              ? "Your session expired. Saved work is safe—open Profile, sign out, then sign in with the same account."
              : officeSyncError
                ? `The latest office activity could not be checked. ${officeSyncError}`
              : failed > 0
              ? `${failed} ${failed === 1 ? "upload needs" : "uploads need"} attention. Open the details below to retry.`
              : lastSyncAt
                ? `Last office update ${new Date(lastSyncAt).toLocaleTimeString("en-PK", { hour: "2-digit", minute: "2-digit" })}.`
                : "FieldOPS sends saved work automatically when the internet is available."}
          </Text>
        </View>
        <View className={classes("h-12 min-w-12 items-center justify-center rounded-full px-3", pending === 0 ? "bg-[#1E5A49]" : "bg-[#682238]")}>
          <Text className="font-black text-white">{pending}</Text>
        </View>
      </View>
      <View className="mt-5"><Button label={syncing || checking ? "Checking & sending…" : "Check & send now"} onPress={onRetry} disabled={syncing || checking || online === false} /></View>
    </View>
    <View className="flex-row justify-between border-y border-line py-4">
      <Stat value={`${activity.length}`} label="Recent activity" />
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
            item.status === "approved" ? "bg-[#DFF3E9]" : item.status === "rejected" ? "bg-[#FCEDEA]" : item.status === "pending_review" ? "bg-[#FFF1D0]" : "bg-[#F8E9EE]",
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
      <View className={classes("h-11 min-w-11 items-center justify-center rounded-xl px-3", locationRejected > 0 ? "bg-[#FCEDEA]" : "bg-[#F8E9EE]")}>
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
                    ? item.retryable === false ? "Needs attention" : "Retry scheduled"
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
  routePolicy,
  backgroundRoute,
  backgroundRouteBusy,
  pending,
  territoryMessage,
  onEnableBackgroundRoute,
  onDisableBackgroundRoute,
  onOpenSettings,
  onLogout,
}: {
  session: Session;
  workState: WorkState;
  trackingReady: boolean;
  routePolicy: MobileOperationsPolicy;
  backgroundRoute: BackgroundRouteStatus;
  backgroundRouteBusy: boolean;
  pending: number;
  territoryMessage: string;
  onEnableBackgroundRoute: () => void;
  onDisableBackgroundRoute: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const continuityState = backgroundRoute.enabled && backgroundRoute.permission === "granted"
    ? workState === "active" && backgroundRoute.running ? "On now" : "Ready"
    : backgroundRoute.enabled
      ? "Needs permission"
      : "Optional";
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
        Route recording runs only during an active work session. Saved points upload automatically when a connection returns.
      </BodyText>
      <ProfileLine>Today: {workState.replace("_", " ")}</ProfileLine>
      <ProfileLine>Phone location: {trackingReady ? "Ready" : "Needs attention"}</ProfileLine>
      <ProfileLine>Work area: {territoryMessage}</ProfileLine>
      <ProfileLine>Capture rule: save a reliable GPS fix about every {routePolicy.sampleIntervalSeconds} s</ProfileLine>
      <ProfileLine>Map cleanup: ignore movement smaller than about {routePolicy.distanceIntervalMeters} m</ProfileLine>
      <ProfileLine>Route quality: fixes weaker than about ±{routePolicy.maxAcceptedAccuracyMeters} m are left out of the drawn line</ProfileLine>
      <ProfileLine>Route recording: {workState === "active" && trackingReady ? "Active" : "Stopped"}</ProfileLine>
      <ProfileLine>Records waiting: {pending}</ProfileLine>
      <ProfileLine>Visit media: photos and voice notes auto-delete from the office after 7 days</ProfileLine>
    </View>
    <View className="gap-3 rounded-[14px] border border-[#B7C7E6] bg-[#EEF3FB] p-[18px]">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Eyebrow>OPTIONAL CONTINUITY</Eyebrow>
          <Text className="mt-1 text-xl font-black text-ink">Keep the route through screen lock</Text>
        </View>
        <View className={classes(
          "rounded-full px-3 py-1.5",
          backgroundRoute.enabled && backgroundRoute.permission === "granted" ? "bg-[#DFF3E9]" : "bg-white",
        )}>
          <Text className={classes(
            "text-[10px] font-black uppercase tracking-wider",
            backgroundRoute.enabled && backgroundRoute.permission === "granted" ? "text-success" : "text-muted",
          )}>{continuityState}</Text>
        </View>
      </View>
      <BodyText>
        If you enable this, FieldOPS can keep recording while the screen is locked or another app is open. It starts only after Start work and stops at Finish session or sign out.
      </BodyText>
      {!backgroundRoute.supported
        ? <InfoNotice title="Not supported here" body="Foreground route recording still works while FieldOPS is open. Test this feature in an installed production build, not Expo Go." />
        : backgroundRoute.enabled && backgroundRoute.permission !== "granted"
          ? <InfoNotice title="Permission changed" body="Allow Always or background location in phone settings, or turn this option off. Foreground work is not blocked." />
          : null}
      {backgroundRoute.enabled
        ? <GhostButton dark label={backgroundRouteBusy ? "Updating…" : "Turn off screen-lock continuity"} disabled={backgroundRouteBusy} onPress={onDisableBackgroundRoute} />
        : <Button label={backgroundRouteBusy ? "Checking permission…" : "Enable screen-lock continuity"} disabled={backgroundRouteBusy || !backgroundRoute.supported} onPress={onEnableBackgroundRoute} />}
      {backgroundRoute.enabled && backgroundRoute.permission !== "granted" && <GhostButton dark label="Open phone settings" onPress={onOpenSettings} />}
    </View>
    <GhostButton dark label="Sign out" onPress={onLogout} />
  </>;
}

type MobileIconName = "today" | "route" | "deals" | "sync" | "profile";

function MobileIcon({ name, color }: { name: MobileIconName; color: string }) {
  // Native geometry avoids icon-font loading flashes and adds no native module.
  const stroke = { borderColor: color, borderWidth: 1.7 };
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: 22, height: 22 }}>
    {name === "today" && <><View style={{ ...stroke, position: "absolute", top: 2, left: 5, width: 12, height: 12, transform: [{ rotate: "45deg" }], borderRightWidth: 0, borderBottomWidth: 0 }} /><View style={{ ...stroke, position: "absolute", top: 9, left: 4, width: 14, height: 12, borderTopWidth: 0, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 }} /><View style={{ ...stroke, position: "absolute", left: 9, bottom: 1, width: 5, height: 7, borderBottomWidth: 0 }} /></>}
    {name === "route" && <><View style={{ ...stroke, position: "absolute", left: 3, top: 1, width: 16, height: 20, borderRadius: 3 }} />{[6, 11, 16].map((top) => <View key={top} style={{ position: "absolute", left: 7, top, width: 8, height: 1.7, backgroundColor: color }} />)}</>}
    {name === "deals" && <>{[8, 14, 20].map((height, index) => <View key={height} style={{ ...stroke, position: "absolute", bottom: 1, left: 2 + index * 7, width: 5, height, borderRadius: 1.5 }} />)}</>}
    {name === "sync" && <><View style={{ ...stroke, width: 20, height: 20, left: 1, top: 1, borderRadius: 10 }} /><View style={{ ...stroke, position: "absolute", left: 6, top: 6, width: 10, height: 6, borderTopWidth: 0, borderRightWidth: 0, transform: [{ rotate: "-45deg" }] }} /></>}
    {name === "profile" && <><View style={{ ...stroke, position: "absolute", left: 7, top: 0, width: 9, height: 9, borderRadius: 5 }} /><View style={{ ...stroke, position: "absolute", left: 3, bottom: 0, width: 17, height: 10, borderTopLeftRadius: 9, borderTopRightRadius: 9, borderBottomWidth: 0 }} /></>}
  </View>;
}

function Nav({ screen, pending, setScreen }: { screen: Screen; pending: number; setScreen: (screen: Screen) => void }) {
  const items: { key: MobileIconName; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "route", label: "Visits" },
    { key: "deals", label: "Sales" },
    { key: "sync", label: "Activity" },
    { key: "profile", label: "Profile" },
  ];
  const selectedKey: Screen = screen === "visit" || screen === "new_visit"
    ? "route"
    : screen === "order" ? "today" : screen;
  return <View accessibilityRole="tablist" className="mx-3 mb-1 flex-row rounded-[24px] bg-ink px-1.5 py-2">
    {items.map((item) => <TouchableOpacity
      key={item.key}
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: selectedKey === item.key }}
      className={classes(
        "relative min-h-[58px] flex-1 items-center justify-center gap-1.5 rounded-[18px]",
        selectedKey === item.key && "bg-white/5",
      )}
      onPress={() => setScreen(item.key)}
    >
      <MobileIcon name={item.key} color={selectedKey === item.key ? "#FF6B8C" : "#A99C9F"} />
      <Text className={classes("text-[10px] font-semibold", selectedKey === item.key ? "text-white" : "text-[#C1B6B9]")}>{item.label}</Text>
      {item.key === "sync" && pending > 0 && <View className="absolute right-1.5 top-1.5 min-w-4 items-center rounded-full bg-gold px-1"><Text className="text-[8px] font-black text-ink">{pending > 9 ? "9+" : pending}</Text></View>}
    </TouchableOpacity>)}
  </View>;
}

function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    className={classes(
      "min-h-12 items-center justify-center rounded-[14px] bg-field px-4 py-3",
      disabled && "opacity-45",
    )}
    onPress={onPress}
    disabled={disabled}
  >
    <Text className="text-center font-semibold text-white">{label}</Text>
  </TouchableOpacity>;
}

function GhostButton({ label, onPress, dark = false, disabled = false }: { label: string; onPress: () => void; dark?: boolean; disabled?: boolean }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    className={classes(
      "min-h-12 items-center justify-center rounded-[14px] border px-4 py-3",
      dark ? "border-line bg-white" : "border-[#B27B8D]",
      disabled && "opacity-45",
    )}
    onPress={onPress}
    disabled={disabled}
  >
    <Text className={classes("text-center font-semibold", dark ? "text-ink" : "text-white")}>{label}</Text>
  </TouchableOpacity>;
}

function DangerOutlineButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    className={classes("min-h-12 items-center justify-center rounded-[9px] border border-danger bg-white px-4 py-3", disabled && "opacity-45")}
    onPress={onPress}
    disabled={disabled}
  >
    <Text className="font-black text-danger">{label}</Text>
  </TouchableOpacity>;
}

function CompactButton({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  return <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={`Move visit ${label.toLowerCase()}`}
    accessibilityState={{ disabled }}
    className={classes("min-h-11 min-w-16 items-center justify-center rounded-lg bg-[#F8EAEE] px-3", disabled && "opacity-35")}
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
    className="min-h-11 items-center justify-center rounded-lg border border-field bg-[#FFF4F7] px-3"
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
    placeholderTextColor="#75686B"
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
    "overflow-hidden rounded-lg px-2.5 py-1.5 text-[11px] font-semibold capitalize",
    status === "completed" ? "bg-[#E5F2E9] text-success" : status === "active" ? "bg-[#FFF0D9] text-[#805717]" : "bg-[#F3EEEB] text-muted",
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
    body="Your point, photo, and voice sales report reached the office. Admin will confirm the sales area and official name before saving this as a permanent outlet."
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
  return <Text accessibilityRole="header" className="text-[28px] font-bold leading-9 text-ink">{children}</Text>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text accessibilityRole="header" className="mt-2 text-[20px] font-bold text-ink">{children}</Text>;
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
    <Text className="mt-1 leading-5 text-[#75686B]">{body}</Text>
  </View>;
}

function WarningNotice({ title, body }: { title: string; body: string }) {
  return <View accessibilityRole="alert" className="rounded-lg border-l-4 border-gold bg-[#FFF1D0] p-3.5">
    <Text className="font-black text-ink">{title}</Text>
    <Text className="mt-1 leading-5 text-[#6C570F]">{body}</Text>
  </View>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <View className="items-center rounded-[22px] border border-line bg-white p-7">
    <Text className="text-center text-lg font-bold text-ink">{title}</Text>
    <Text className="mt-1.5 text-center leading-5 text-[#75686B]">{body}</Text>
  </View>;
}

function ProfileLine({ children }: { children: React.ReactNode }) {
  return <Text className="border-t border-line pt-3 font-bold leading-5 text-ink">{children}</Text>;
}

function LogoMark({ size }: { size: number }) {
  return <View className="overflow-hidden bg-[#F7F7F7]" style={{ width: size, height: size, borderRadius: size * 0.28 }}>
    <Image accessibilityLabel="FieldOPS ribbon-heart logo" accessibilityIgnoresInvertColors source={FIELDOPS_MARK} style={{ width: size, height: size }} resizeMode="contain" />
  </View>;
}
