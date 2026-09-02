import { validRouteSegments, type MapCoordinate } from "./map-coordinates.ts";

export type MapPoint = { id: string; name: string; address: string; latitude: number; longitude: number; kind: "outlet" | "visit" | "live" };
export type RouteLine = { id: string; name: string; color: string; coordinates: MapCoordinate[]; estimated?: boolean };

export function buildMapRoutes(routes: readonly RouteLine[]) {
  return {
    type: "FeatureCollection" as const,
    features: routes.flatMap((route) => {
      const coordinates = validRouteSegments(route.coordinates);
      return coordinates.length ? [{
        type: "Feature" as const,
        id: route.id,
        properties: { name: route.name, color: route.color, estimated: Boolean(route.estimated) },
        geometry: { type: "MultiLineString" as const, coordinates },
      }] : [];
    }),
  };
}
