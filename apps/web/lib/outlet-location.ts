import { pointInTerritory, type Coordinate, type TerritoryBoundary } from "@fieldops/domain";

export type MappedSalesArea = { id: string; boundary: TerritoryBoundary | null };

export function salesAreasAtPoint<T extends MappedSalesArea>(point: Coordinate, territories: readonly T[]): T[] {
  if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
    || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return [];
  return territories.filter((territory) => territory.boundary && pointInTerritory(point, territory.boundary))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function effectiveSalespeople(
  territoryIds: readonly string[],
  assignments: readonly Record<string, unknown>[],
  activeEmployeeIds: ReadonlySet<string>,
  salesRoleIds: ReadonlySet<string>,
  at: Date,
) {
  return [...new Set(assignments.filter((assignment) => {
    const start = new Date(String(assignment.effective_from)).valueOf();
    const end = assignment.effective_to ? new Date(String(assignment.effective_to)).valueOf() : Infinity;
    return territoryIds.includes(String(assignment.territory_id))
      && activeEmployeeIds.has(String(assignment.employee_id))
      && salesRoleIds.has(String(assignment.role_id))
      && start <= at.valueOf() && end > at.valueOf();
  }).map((assignment) => String(assignment.employee_id)))].sort();
}

export function googleMapsUrl(latitude: number, longitude: number) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
}

export function outletPointAddress(latitude: number, longitude: number) {
  return `Map pin: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}
