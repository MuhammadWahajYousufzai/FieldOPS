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

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
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
