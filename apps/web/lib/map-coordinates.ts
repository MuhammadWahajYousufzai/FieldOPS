export type MapCoordinate = [longitude: number, latitude: number];
export type LeafletCoordinate = [latitude: number, longitude: number];

export function validMapCoordinate(value: unknown): value is MapCoordinate {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "number" && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === "number" && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90;
}

export function toLeafletCoordinate(value: MapCoordinate): LeafletCoordinate {
  return [value[1], value[0]];
}

// Split, rather than filtering, so invalid fixes cannot invent a connecting line.
export function leafletRouteSegments(coordinates: readonly MapCoordinate[]): LeafletCoordinate[][] {
  const segments: LeafletCoordinate[][] = [];
  let current: LeafletCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (validMapCoordinate(coordinate)) current.push(toLeafletCoordinate(coordinate));
    else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
