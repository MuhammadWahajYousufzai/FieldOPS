import { pointInTerritory, type TerritoryBoundary } from "@fieldops/domain";

export type TerritoryOutletPoint = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

export type TerritoryImpact = {
  checked: number;
  invalid: TerritoryOutletPoint[];
  outside: TerritoryOutletPoint[];
};

/**
 * Previews the effect of a boundary change without mutating outlet data.
 * Invalid legacy coordinates are reported separately so callers never treat
 * unreadable data as safely contained by the new polygon.
 */
export function territoryBoundaryImpact(
  boundary: TerritoryBoundary,
  outlets: readonly TerritoryOutletPoint[],
): TerritoryImpact {
  const invalid: TerritoryOutletPoint[] = [];
  const outside: TerritoryOutletPoint[] = [];

  for (const outlet of outlets) {
    const valid = Number.isFinite(outlet.latitude)
      && Number.isFinite(outlet.longitude)
      && Math.abs(outlet.latitude) <= 90
      && Math.abs(outlet.longitude) <= 180;
    if (!valid) {
      invalid.push(outlet);
      continue;
    }
    if (!pointInTerritory(outlet, boundary)) outside.push(outlet);
  }

  return { checked: outlets.length, invalid, outside };
}
