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
  accuracyMeters: number,
) {
  const distance = distanceMeters(outlet, checkIn);
  return { distanceMeters: Math.round(distance), accepted: distance <= radiusMeters + accuracyMeters };
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
