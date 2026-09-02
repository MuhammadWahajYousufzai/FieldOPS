"use client";

import type { Marker, Polyline } from "leaflet";
import { useEffect, useRef } from "react";
import { leafletRouteSegments, toLeafletCoordinate, validMapCoordinate } from "../lib/map-coordinates";
import { useLeafletMap, type LeafletContext } from "./use-leaflet-map";

export type MapPoint = {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  kind: "outlet" | "visit" | "live";
};

export type RouteLine = {
  id: string;
  name: string;
  color: string;
  coordinates: [number, number][];
  estimated?: boolean;
};

export function OperationsMap({ points, routes = [] }: { points: MapPoint[]; routes?: RouteLine[] }) {
  const { container, context, error, retry } = useLeafletMap();
  const markers = useRef(new Map<string, Marker>());
  const lines = useRef(new Map<string, Polyline>());
  const fitted = useRef(false);

  useEffect(() => {
    markers.current.clear();
    lines.current.clear();
    fitted.current = false;
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const { map, leaflet } = context;
    const visibleRoutes = routes.filter((route) => leafletRouteSegments(route.coordinates).length > 0);
    const nextRouteIds = new Set(visibleRoutes.map((route) => route.id));
    for (const [id, line] of lines.current) {
      if (!nextRouteIds.has(id)) { line.remove(); lines.current.delete(id); }
    }
    for (const route of visibleRoutes) {
      const coordinates = leafletRouteSegments(route.coordinates);
      const style = { color: route.color, weight: route.estimated ? 3 : 4, opacity: route.estimated ? 0.68 : 0.85, dashArray: route.estimated ? "6 6" : undefined };
      const line = lines.current.get(route.id);
      if (line) line.setLatLngs(coordinates).setStyle(style);
      else lines.current.set(route.id, leaflet.polyline(coordinates, { ...style, className: route.estimated ? "fieldops-route-estimated" : "fieldops-route-recorded" }).addTo(map));
    }

    const visiblePoints = points.filter((point) => validMapCoordinate([point.longitude, point.latitude]));
    const nextPointIds = new Set(visiblePoints.map((point) => point.id));
    for (const [id, marker] of markers.current) {
      if (!nextPointIds.has(id)) { marker.remove(); markers.current.delete(id); }
    }
    for (const point of visiblePoints) {
      const position: [number, number] = [point.latitude, point.longitude];
      const popup = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = point.name;
      const address = document.createElement("div");
      address.textContent = point.address;
      popup.append(title, address);
      const existing = markers.current.get(point.id);
      if (existing) existing.setLatLng(position).setPopupContent(popup);
      else {
        const icon = leaflet.divIcon({ className: `fieldops-map-marker fieldops-map-marker--${point.kind}`, html: '<span aria-hidden="true"></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
        const marker = leaflet.marker(position, { icon, title: point.name, alt: point.name, keyboard: true }).bindPopup(popup).addTo(map);
        markers.current.set(point.id, marker);
      }
    }
    if (!fitted.current) fitted.current = fitMapToContent(context, points, routes);
  }, [context, points, routes]);

  return <div className="relative isolate mt-5 h-[350px] w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 sm:h-[430px]">
    <div className="h-full w-full" ref={container} role="region" aria-label="Map of assigned outlets and captured visit locations" />
    {!context && <div className="absolute inset-0 z-[1000] grid place-content-center bg-slate-50/95 p-6 text-center" role="status">
      <p className="font-bold">{error ? "The map could not load. Please retry." : "Loading street map…"}</p>
      {error && <button type="button" className="mt-3 rounded-lg bg-[#5269FF] px-4 py-2 font-bold text-white" onClick={retry}>Retry map</button>}
    </div>}
    <button type="button" disabled={!context} className="absolute bottom-7 left-3 z-[1000] min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-black text-[#14213D] shadow-md hover:bg-slate-50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#5269FF] disabled:opacity-50" onClick={() => { if (context) fitMapToContent(context, points, routes); }}>Fit route</button>
  </div>;
}

function fitMapToContent({ map, leaflet }: LeafletContext, points: MapPoint[], routes: RouteLine[]) {
  const routeCoordinates = routes.flatMap((route) => route.coordinates).filter(validMapCoordinate).map(toLeafletCoordinate);
  const coordinates = routeCoordinates.length ? routeCoordinates : points.flatMap((point): [number, number][] => validMapCoordinate([point.longitude, point.latitude]) ? [[point.latitude, point.longitude]] : []);
  if (!coordinates.length) return false;
  if (coordinates.length === 1) map.setView(coordinates[0]!, 15, { animate: false });
  else map.fitBounds(leaflet.latLngBounds(coordinates), { padding: [45, 45], maxZoom: 15, animate: false });
  return true;
}
