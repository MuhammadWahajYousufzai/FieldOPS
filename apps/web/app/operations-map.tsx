"use client";

import type { GeoJSONSource, Marker } from "maplibre-gl";
import { memo, useEffect, useMemo, useRef } from "react";
import { validMapCoordinate } from "../lib/map-coordinates";
import { buildMapRoutes, type MapPoint, type RouteLine } from "../lib/map-route-data";
import { MapStatus } from "./map-status";
import { useVectorMap, type VectorMapContext } from "./use-vector-map";

export type { MapPoint, RouteLine } from "../lib/map-route-data";
const noRoutes: RouteLine[] = [];

export const OperationsMap = memo(function OperationsMap({ points, routes = noRoutes }: { points: MapPoint[]; routes?: RouteLine[] }) {
  const { container, context, error, retry } = useVectorMap();
  const markers = useRef(new Map<string, { marker: Marker; point: MapPoint }>());
  const fitted = useRef(false);
  const lastRoutes = useRef("");
  const routeData = useMemo(() => buildMapRoutes(routes), [routes]);

  useEffect(() => {
    markers.current.clear();
    fitted.current = false;
    lastRoutes.current = "";
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const { map } = context;
    const signature = JSON.stringify(routeData);
    if (!map.getSource("fieldops-routes")) {
      map.addSource("fieldops-routes", { type: "geojson", data: routeData });
      map.addLayer({ id: "fieldops-route-recorded", type: "line", source: "fieldops-routes",
        filter: ["==", ["get", "estimated"], false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.9 } });
      map.addLayer({ id: "fieldops-route-estimated", type: "line", source: "fieldops-routes",
        filter: ["==", ["get", "estimated"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.7, "line-dasharray": [2, 2] } });
    } else if (signature !== lastRoutes.current) {
      (map.getSource("fieldops-routes") as GeoJSONSource).setData(routeData);
    }
    lastRoutes.current = signature;
  }, [context, routeData]);

  useEffect(() => {
    if (!context) return;
    const { map, lib } = context;
    const validPoints = points.filter((point) => validMapCoordinate([point.longitude, point.latitude]));
    const ids = new Set(validPoints.map((point) => point.id));
    for (const [id, record] of markers.current) {
      if (!ids.has(id)) { record.marker.remove(); markers.current.delete(id); }
    }
    for (const point of validPoints) {
      const existing = markers.current.get(point.id);
      if (existing) {
        if (point.longitude !== existing.point.longitude || point.latitude !== existing.point.latitude) existing.marker.setLngLat([point.longitude, point.latitude]);
        if (point.name !== existing.point.name || point.address !== existing.point.address) existing.marker.getPopup()?.setDOMContent(popupContent(point));
        if (point.kind !== existing.point.kind) {
          existing.marker.getElement().classList.remove(`fieldops-map-marker--${existing.point.kind}`);
          existing.marker.getElement().classList.add(`fieldops-map-marker--${point.kind}`);
        }
        existing.marker.getElement().setAttribute("aria-label", point.name);
        existing.point = point;
      } else {
        const element = document.createElement("button");
        element.type = "button";
        element.className = `fieldops-map-marker fieldops-map-marker--${point.kind}`;
        element.setAttribute("aria-label", point.name);
        const dot = document.createElement("span");
        dot.setAttribute("aria-hidden", "true");
        element.append(dot);
        const marker = new lib.Marker({ element, anchor: "center" })
          .setLngLat([point.longitude, point.latitude])
          .setPopup(new lib.Popup({ offset: 18 }).setDOMContent(popupContent(point))).addTo(map);
        markers.current.set(point.id, { marker, point });
      }
    }
  }, [context, points]);

  useEffect(() => {
    if (context && !fitted.current) fitted.current = fitMapToContent(context, points, routes, 0);
  }, [context, points, routes]);

  return <div className="relative isolate mt-5 h-[350px] w-full overflow-hidden rounded-2xl border border-[#D7DFEC] bg-[#F5F7FB] sm:h-[430px]">
    <div className="h-full w-full" ref={container} role="region" aria-label="Map of assigned outlets and captured visit locations" />
    <MapStatus ready={Boolean(context)} error={error} retry={retry} />
    <button type="button" disabled={!context} className="absolute bottom-7 left-3 z-10 min-h-10 rounded-lg border border-slate-300 bg-white px-3 text-xs font-black text-[#2D2729] shadow-md hover:bg-slate-50 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#CB183D] disabled:opacity-50" onClick={() => { if (context) fitMapToContent(context, points, routes, 400); }}>Fit route</button>
  </div>;
});

function popupContent(point: MapPoint) {
  const content = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = point.name;
  const address = document.createElement("div");
  address.textContent = point.address;
  content.append(title, address);
  return content;
}

function fitMapToContent({ map, lib }: VectorMapContext, points: MapPoint[], routes: RouteLine[], duration: number) {
  const routeCoordinates = routes.flatMap((route) => route.coordinates).filter(validMapCoordinate);
  const coordinates = routeCoordinates.length ? routeCoordinates : points.flatMap((point): [number, number][] => validMapCoordinate([point.longitude, point.latitude]) ? [[point.longitude, point.latitude]] : []);
  if (!coordinates.length) return false;
  if (coordinates.length === 1) map.easeTo({ center: coordinates[0]!, zoom: 15, duration });
  else {
    const bounds = new lib.LngLatBounds();
    for (const point of coordinates) bounds.extend(point);
    map.fitBounds(bounds, { padding: 45, maxZoom: 15, duration });
  }
  return true;
}
