export type MapCoordinate = [longitude: number, latitude: number];

export function validMapCoordinate(value: unknown): value is MapCoordinate {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "number" && Number.isFinite(value[0]) && Math.abs(value[0]) <= 180
    && typeof value[1] === "number" && Number.isFinite(value[1]) && Math.abs(value[1]) <= 90;
}

// Split, rather than filtering, so invalid fixes cannot invent a connecting line.
export function validRouteSegments(coordinates: readonly MapCoordinate[]): MapCoordinate[][] {
  const segments: MapCoordinate[][] = [];
  let current: MapCoordinate[] = [];
  for (const coordinate of coordinates) {
    if (validMapCoordinate(coordinate)) current.push(coordinate);
    else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}
