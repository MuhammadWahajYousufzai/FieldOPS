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
