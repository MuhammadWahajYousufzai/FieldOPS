export const PRODUCT_NAME = "Yousuf Rice FieldOps" as const;

export const permissions = [
  "employees:view:all", "employees:view:assigned", "location:view:live",
  "location:view:history", "customers:create", "customers:approve",
  "orders:create", "discounts:approve", "payments:receive",
  "territories:manage", "reports:export", "audit:view"
] as const;

export type Permission = (typeof permissions)[number];
export type Scope = { regionIds: string[]; territoryIds: string[] };
export type AccessContext = { permissions: ReadonlySet<Permission>; scope: Scope };

export function canAccessTerritory(
  actor: AccessContext,
  permission: Permission,
  territoryId: string,
): boolean {
  return actor.permissions.has(permission) && actor.scope.territoryIds.includes(territoryId);
}

export type Coordinate = { latitude: number; longitude: number };
export type LngLat = [longitude: number, latitude: number];
export type TerritoryBoundary = { type: "Polygon"; coordinates: LngLat[][] };
export const MAX_PLACE_MARK_ACCURACY_METERS = 50;
const EARTH_RADIUS_METERS = 6_371_000;

export type RouteTrackingPolicy = {
  sampleIntervalSeconds: number;
  distanceIntervalMeters: number;
  maxAcceptedAccuracyMeters: number;
  stationaryJitterMeters: number;
  segmentGapMinutes: number;
  maxPlausibleSpeedMps: number;
};

export type RouteTrackPoint = Coordinate & {
  capturedAt: string;
  accuracy: number;
  id?: string;
  speed?: number | null;
};

export const DEFAULT_ROUTE_TRACKING_POLICY: Readonly<RouteTrackingPolicy> = Object.freeze({
  sampleIntervalSeconds: 15,
  distanceIntervalMeters: 10,
  maxAcceptedAccuracyMeters: 35,
  stationaryJitterMeters: 20,
  segmentGapMinutes: 5,
  maxPlausibleSpeedMps: 45,
});

// Native location providers report speed in metres per second. A non-negative
// value below this threshold is an explicit stationary signal; negative or
// missing values mean the provider could not determine speed and must not be
// treated as stationary.
const STATIONARY_REPORTED_SPEED_MPS = 0.5;

/**
 * Treat manager-provided tracking values as untrusted operational input. The
 * bounds keep an accidental dashboard value from disabling collection,
 * exhausting a phone battery, or drawing physically impossible route legs.
 */
export function normalizeRouteTrackingPolicy(value: unknown): RouteTrackingPolicy {
  const input = value && typeof value === "object" ? value as Partial<Record<keyof RouteTrackingPolicy, unknown>> : {};
  return {
    sampleIntervalSeconds: boundedNumber(input.sampleIntervalSeconds, 5, 300, DEFAULT_ROUTE_TRACKING_POLICY.sampleIntervalSeconds),
    distanceIntervalMeters: boundedNumber(input.distanceIntervalMeters, 3, 1_000, DEFAULT_ROUTE_TRACKING_POLICY.distanceIntervalMeters),
    maxAcceptedAccuracyMeters: boundedNumber(input.maxAcceptedAccuracyMeters, 5, 250, DEFAULT_ROUTE_TRACKING_POLICY.maxAcceptedAccuracyMeters),
    stationaryJitterMeters: boundedNumber(input.stationaryJitterMeters, 0, 100, DEFAULT_ROUTE_TRACKING_POLICY.stationaryJitterMeters),
    segmentGapMinutes: boundedNumber(input.segmentGapMinutes, 1, 60, DEFAULT_ROUTE_TRACKING_POLICY.segmentGapMinutes),
    maxPlausibleSpeedMps: boundedNumber(input.maxPlausibleSpeedMps, 5, 100, DEFAULT_ROUTE_TRACKING_POLICY.maxPlausibleSpeedMps),
  };
}

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function isReliableRoutePoint(
  point: RouteTrackPoint,
  policy: RouteTrackingPolicy = DEFAULT_ROUTE_TRACKING_POLICY,
): boolean {
  return Number.isFinite(point.latitude)
    && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude)
    && Math.abs(point.longitude) <= 180
    && Number.isFinite(point.accuracy)
    && point.accuracy > 0
    && point.accuracy <= policy.maxAcceptedAccuracyMeters
    && Number.isFinite(new Date(point.capturedAt).valueOf());
}

/**
 * Applies the phone-side capture policy. A stationary heartbeat is retained
 * about every two minutes so managers can distinguish a stopped employee from
 * a stopped GPS receiver, while small interim movements inside the fix's
 * uncertainty are ignored.
 */
export function shouldCaptureRoutePoint(
  previous: RouteTrackPoint | null,
  candidate: RouteTrackPoint,
  policy: RouteTrackingPolicy = DEFAULT_ROUTE_TRACKING_POLICY,
): boolean {
  if (!isReliableRoutePoint(candidate, policy)) return false;
  if (!previous || !isReliableRoutePoint(previous, policy)) return true;

  const elapsedMs = new Date(candidate.capturedAt).valueOf() - new Date(previous.capturedAt).valueOf();
  if (elapsedMs <= 0) return false;
  const distance = distanceMeters(previous, candidate);
  const speed = distance / (elapsedMs / 1_000);
  if (speed > policy.maxPlausibleSpeedMps) return false;

  const heartbeatSeconds = Math.max(60, Math.min(120, policy.sampleIntervalSeconds * 8));
  // When the native motion estimate explicitly says the phone is stationary,
  // a displaced coordinate is GPS wander rather than evidence of travel. Keep
  // only the periodic raw heartbeat so a stop remains visible in the audit log.
  if (reportsStationary(candidate)) return elapsedMs >= heartbeatSeconds * 1_000;

  const movementThreshold = routeJitterThreshold(previous, candidate, policy);
  if (distance >= movementThreshold) return true;
  return elapsedMs >= heartbeatSeconds * 1_000;
}

/**
 * Converts raw audit points into honest map geometry. Raw points remain stored
 * and visible in the audit table; only the drawn line is quality-filtered.
 * Poor fixes are omitted, stationary GPS drift is suppressed, duplicate action
 * points are collapsed, and long gaps/implausible jumps begin a new segment
 * instead of inventing a diagonal route the salesperson never travelled.
 */
export function buildRouteSegments<Point extends RouteTrackPoint>(
  points: readonly Point[],
  policy: RouteTrackingPolicy = DEFAULT_ROUTE_TRACKING_POLICY,
): Point[][] {
  const reliable = points
    .map((point, index) => ({ point, index, time: new Date(point.capturedAt).valueOf() }))
    .filter(({ point }) => isReliableRoutePoint(point, policy))
    .sort((a, b) => a.time - b.time || String(a.point.id ?? "").localeCompare(String(b.point.id ?? "")) || a.index - b.index);

  const deduplicated: typeof reliable = [];
  for (const candidate of reliable) {
    const previous = deduplicated.at(-1);
    if (previous && Math.abs(candidate.time - previous.time) <= 1_000) {
      if (candidate.point.accuracy < previous.point.accuracy) deduplicated[deduplicated.length - 1] = candidate;
      continue;
    }
    deduplicated.push(candidate);
  }

  // Keep the initial anchor, but do not turn explicit native stationary
  // heartbeats into route geometry. Their unmodified coordinates remain in the
  // raw audit log. This prevents a lunch/prayer pause from becoming an oval
  // even when every wandering fix individually has acceptable accuracy.
  const withoutStationaryDrift = deduplicated.filter((candidate, index) => (
    index === 0 || !reportsStationary(candidate.point)
  ));

  // A single bad coordinate between two plausible fixes creates the exact
  // triangle/oval artifact reported in the field. Remove only physically
  // impossible spikes whose neighbours form a plausible leg; real turns and
  // out-and-back paths remain intact.
  const withoutSpikes = withoutStationaryDrift.filter((candidate, index, values) => {
    const previous = values[index - 1];
    const next = values[index + 1];
    if (!previous || !next) return true;
    const beforeSeconds = (candidate.time - previous.time) / 1_000;
    const afterSeconds = (next.time - candidate.time) / 1_000;
    const acrossSeconds = (next.time - previous.time) / 1_000;
    if (beforeSeconds <= 0 || afterSeconds <= 0 || acrossSeconds <= 0) return false;
    const beforeSpeed = distanceMeters(previous.point, candidate.point) / beforeSeconds;
    const afterSpeed = distanceMeters(candidate.point, next.point) / afterSeconds;
    const acrossSpeed = distanceMeters(previous.point, next.point) / acrossSeconds;
    return !(beforeSpeed > policy.maxPlausibleSpeedMps
      && afterSpeed > policy.maxPlausibleSpeedMps
      && acrossSpeed <= policy.maxPlausibleSpeedMps);
  });

  const segments: Point[][] = [];
  let segment: Point[] = [];
  let previous: (typeof withoutSpikes)[number] | undefined;
  const segmentGapMs = policy.segmentGapMinutes * 60_000;

  for (const candidate of withoutSpikes) {
    if (!previous) {
      segment = [candidate.point];
      previous = candidate;
      continue;
    }

    const elapsedMs = candidate.time - previous.time;
    const distance = distanceMeters(previous.point, candidate.point);
    const speed = distance / Math.max(1, elapsedMs / 1_000);
    if (elapsedMs > segmentGapMs || speed > policy.maxPlausibleSpeedMps) {
      if (segment.length > 0) segments.push(segment);
      segment = [candidate.point];
      previous = candidate;
      continue;
    }

    if (distance < routeJitterThreshold(previous.point, candidate.point, policy)) continue;
    segment.push(candidate.point);
    previous = candidate;
  }

  if (segment.length > 0) segments.push(segment);
  return segments;
}

/**
 * Returns honest, explicitly estimated links between otherwise reliable route
 * segments. These links help a manager understand the general direction after
 * a short GPS interruption without presenting an invented path as recorded.
 * Stationary pauses, physically impossible jumps, and gaps over two hours are
 * deliberately left disconnected.
 */
export function buildRouteGapConnectors<Point extends RouteTrackPoint>(
  segments: readonly (readonly Point[])[],
  policy: RouteTrackingPolicy = DEFAULT_ROUTE_TRACKING_POLICY,
): Array<[Point, Point]> {
  const nonempty = segments.filter((segment) => segment.length > 0);
  const minimumGapMs = policy.segmentGapMinutes * 60_000;
  const maximumGapMs = 120 * 60_000;
  const connectors: Array<[Point, Point]> = [];

  for (let index = 1; index < nonempty.length; index += 1) {
    const from = nonempty[index - 1]?.at(-1);
    const to = nonempty[index]?.[0];
    if (!from || !to) continue;

    const elapsedMs = new Date(to.capturedAt).valueOf() - new Date(from.capturedAt).valueOf();
    if (elapsedMs <= minimumGapMs || elapsedMs > maximumGapMs) continue;

    const distance = distanceMeters(from, to);
    if (distance <= gapUncertaintyMeters(from, to, policy)) continue;
    if (distance / (elapsedMs / 1_000) > policy.maxPlausibleSpeedMps) continue;
    connectors.push([from, to]);
  }

  return connectors;
}

function routeJitterThreshold(
  a: RouteTrackPoint,
  b: RouteTrackPoint,
  policy: RouteTrackingPolicy,
) {
  const accuracyAwareThreshold = Math.max(
    policy.distanceIntervalMeters,
    Math.max(a.accuracy, b.accuracy) * 0.75,
  );
  return Math.min(policy.stationaryJitterMeters, accuracyAwareThreshold);
}

function reportsStationary(point: RouteTrackPoint) {
  return typeof point.speed === "number"
    && Number.isFinite(point.speed)
    && point.speed >= 0
    && point.speed < STATIONARY_REPORTED_SPEED_MPS;
}

function gapUncertaintyMeters(
  a: RouteTrackPoint,
  b: RouteTrackPoint,
  policy: RouteTrackingPolicy,
) {
  return Math.max(policy.stationaryJitterMeters, a.accuracy, b.accuracy);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function evaluateGeofence(
  outlet: Coordinate,
  checkIn: Coordinate,
  radiusMeters: number,
  _accuracyMeters = 0,
) {
  const distance = distanceMeters(outlet, checkIn);
  return { distanceMeters: Math.round(distance), accepted: distance <= radiusMeters };
}

export function hasRequiredVisitEvidence<Evidence extends { photo?: unknown; audio?: unknown }>(
  evidence: Evidence,
): evidence is Evidence & { photo: NonNullable<Evidence["photo"]>; audio: NonNullable<Evidence["audio"]> } {
  return Boolean(evidence.photo) && Boolean(evidence.audio);
}

export const MAX_VISIT_EVIDENCE_BYTES = 20 * 1024 * 1024;

export const VISIT_PHOTO_MIME_TYPES = [
  "image/heic",
  "image/jpeg",
  "image/png",
] as const;

export const VISIT_AUDIO_MIME_TYPES = [
  "audio/aac",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
] as const;

export type VisitEvidenceKind = "photo" | "audio";
export type VisitEvidenceFile = { size: number; type: string };

const visitEvidenceMimeTypes: Record<VisitEvidenceKind, ReadonlySet<string>> = {
  photo: new Set(VISIT_PHOTO_MIME_TYPES),
  audio: new Set(VISIT_AUDIO_MIME_TYPES),
};

const visitEvidenceExtensions: Record<string, string> = {
  "image/heic": ".heic",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "audio/aac": ".aac",
  "audio/m4a": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-m4a": ".m4a",
  "audio/x-wav": ".wav",
};

export function visitEvidenceValidationError(kind: VisitEvidenceKind, file: VisitEvidenceFile): string | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return `The visit ${kind} is empty.`;
  }
  if (file.size > MAX_VISIT_EVIDENCE_BYTES) {
    return `The visit ${kind} must be 20 MB or smaller.`;
  }
  if (!visitEvidenceMimeTypes[kind].has(file.type)) {
    return `The visit ${kind} has an unsupported file type.`;
  }
  return null;
}

export function visitEvidenceExtension(kind: VisitEvidenceKind, mimeType: string): string {
  return visitEvidenceMimeTypes[kind].has(mimeType)
    ? visitEvidenceExtensions[mimeType] ?? (kind === "photo" ? ".jpg" : ".m4a")
    : kind === "photo" ? ".jpg" : ".m4a";
}

type RefreshableVisit = {
  id: string;
  routeId: string;
  status: "planned" | "active" | "completed";
  kind: "assigned" | "self";
  workDate: string;
};

export function mergeRefreshedVisits<Visit extends RefreshableVisit>(
  serverVisits: readonly Visit[],
  localVisits: readonly Visit[],
  workDate: string,
): Visit[] {
  const localAssigned = new Map(
    localVisits
      .filter((visit) => visit.kind === "assigned")
      .map((visit) => [visit.routeId, visit]),
  );
  const localSelf = new Map(
    localVisits
      .filter((visit) => visit.kind === "self" && visit.workDate === workDate)
      .map((visit) => [visit.id, visit]),
  );
  const assigned = serverVisits.filter((visit) => visit.kind === "assigned").map((visit) => {
    const local = localAssigned.get(visit.routeId);
    const status = local?.status === "active" || local?.status === "completed" ? local.status : visit.status;
    return { ...visit, status, kind: "assigned" as const, workDate };
  });
  const serverSelf = serverVisits.filter((visit) => visit.kind === "self").map((visit) => ({
    ...localSelf.get(visit.id),
    ...visit,
    kind: "self" as const,
    workDate,
  }));
  const serverSelfIds = new Set(serverSelf.map((visit) => visit.id));
  const localOnlySelf = [...localSelf.values()].filter((visit) => !serverSelfIds.has(visit.id));
  return [...assigned, ...serverSelf, ...localOnlySelf];
}

export function parseTerritoryBoundary(value: unknown): TerritoryBoundary | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (Array.isArray(candidate)) candidate = { type: "Polygon", coordinates: candidate };
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as { type?: unknown; geometry?: unknown; coordinates?: unknown };
  if (record.type === "Feature") return parseTerritoryBoundary(record.geometry);
  if (record.type !== "Polygon" || !Array.isArray(record.coordinates) || record.coordinates.length === 0) return null;

  const rings: LngLat[][] = [];
  for (const rawRing of record.coordinates) {
    if (!Array.isArray(rawRing) || rawRing.length < 4) return null;
    const ring: LngLat[] = [];
    for (const rawPoint of rawRing) {
      if (!Array.isArray(rawPoint) || rawPoint.length < 2) return null;
      const longitude = Number(rawPoint[0]), latitude = Number(rawPoint[1]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
      ring.push([longitude, latitude]);
    }
    const first = ring[0]!, last = ring.at(-1)!;
    if (first[0] !== last[0] || first[1] !== last[1]) return null;
    rings.push(ring);
  }
  return { type: "Polygon", coordinates: rings };
}

export function pointInTerritory(point: Coordinate, boundary: TerritoryBoundary): boolean {
  const [outer, ...holes] = boundary.coordinates;
  if (!outer || !pointInRing(point, outer)) return false;
  return !holes.some((hole) => pointInRing(point, hole));
}

export function pointInAnyTerritory(point: Coordinate, boundaries: readonly TerritoryBoundary[]): boolean {
  return boundaries.some((boundary) => pointInTerritory(point, boundary));
}

function pointInRing(point: Coordinate, ring: readonly LngLat[]): boolean {
  const x = point.longitude, y = point.latitude;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[previous]!, [x2, y2] = ring[index]!;
    if (pointOnSegment(x, y, x1, y1, x2, y2)) return true;
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function pointOnSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const cross = (y - y1) * (x2 - x1) - (x - x1) * (y2 - y1);
  if (Math.abs(cross) > 1e-10) return false;
  return x >= Math.min(x1, x2) - 1e-10 && x <= Math.max(x1, x2) + 1e-10
    && y >= Math.min(y1, y2) - 1e-10 && y <= Math.max(y1, y2) + 1e-10;
}

export type SyncOperation = {
  idempotencyKey: string;
  entityType: "attendance" | "visit" | "order" | "payment" | "location";
  entityId: string;
  state: "pending" | "syncing" | "failed" | "confirmed";
  attempts: number;
};

export function retryDelayMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts));
}
