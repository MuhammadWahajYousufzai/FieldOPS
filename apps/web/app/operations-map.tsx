"use client";

import maplibregl from "maplibre-gl";
import type { GeoJSONSourceSpecification, LngLatBoundsLike } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

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
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const routeIdsRef = useRef(new Set<string>());
  const hasFittedRef = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [67.035, 24.815],
      zoom: 12.2,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => setReady(true));
    return () => {
      setReady(false);
      markersRef.current.clear();
      routeIdsRef.current.clear();
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const nextRouteIds = new Set<string>();
    for (const route of routes) {
      if (route.coordinates.length < 2) continue;
      const sourceId = routeSourceId(route.id);
      nextRouteIds.add(sourceId);
      const data: GeoJSONSourceSpecification["data"] = { type: "Feature", properties: { name: route.name }, geometry: { type: "LineString", coordinates: route.coordinates } };
      const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (existing) existing.setData(data);
      else {
        map.addSource(sourceId, { type: "geojson", data });
        map.addLayer({
          id: sourceId,
          type: "line",
          source: sourceId,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: route.estimated
            ? { "line-color": route.color, "line-width": 3, "line-opacity": 0.68, "line-dasharray": [1.5, 1.5] }
            : { "line-color": route.color, "line-width": 4, "line-opacity": 0.82 },
        });
      }
    }
    for (const sourceId of routeIdsRef.current) {
      if (nextRouteIds.has(sourceId)) continue;
      if (map.getLayer(sourceId)) map.removeLayer(sourceId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    }
    routeIdsRef.current = nextRouteIds;

    const nextPointIds = new Set(points.map((point) => point.id));
    for (const [id, marker] of markersRef.current) {
      if (nextPointIds.has(id)) continue;
      marker.remove();
      markersRef.current.delete(id);
    }
    for (const point of points) {
      const popupHtml = `<strong>${escape(point.name)}</strong><br><span>${escape(point.address)}</span>`;
      const existing = markersRef.current.get(point.id);
      if (existing) {
        existing.setLngLat([point.longitude, point.latitude]);
        existing.getPopup()?.setHTML(popupHtml);
        continue;
      }
      const marker = point.kind === "live"
        ? new maplibregl.Marker({ element: liveMarker(point.name), anchor: "center" })
        : new maplibregl.Marker({ color: point.kind === "visit" ? "#267057" : "#243d74" });
      marker.setLngLat([point.longitude, point.latitude]).setPopup(new maplibregl.Popup({ offset: 24 }).setHTML(popupHtml)).addTo(map);
      markersRef.current.set(point.id, marker);
    }

    if (!hasFittedRef.current) {
      fitMapToContent(map, points, routes, 0);
      hasFittedRef.current = true;
    }
  }, [points, ready, routes]);

  return <div className="relative mt-5 h-[350px] w-full overflow-hidden rounded-2xl bg-slate-200 sm:h-[430px]">
    <div className="h-full w-full" ref={container} aria-label="Map of assigned outlets and captured visit locations" />
    <button
      type="button"
      className="absolute bottom-3 left-3 z-10 min-h-10 rounded-lg border border-slate-300 bg-white/95 px-3 text-xs font-black text-[#14213D] shadow-md backdrop-blur hover:bg-white focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#D8A629]"
      onClick={() => {
        const map = mapRef.current;
        if (map) fitMapToContent(map, points, routes, 350);
      }}
    >Fit route</button>
  </div>;
}

function fitMapToContent(map: maplibregl.Map, points: MapPoint[], routes: RouteLine[], duration: number) {
  const routeCoordinates = routes.flatMap((route) => route.coordinates);
  const coordinates: [number, number][] = routeCoordinates.length > 0
    ? routeCoordinates
    : points.flatMap((point): [number, number][] => (
      Number.isFinite(point.longitude) && Number.isFinite(point.latitude)
        ? [[point.longitude, point.latitude]]
        : []
    ));
  if (coordinates.length === 0) return;
  if (coordinates.length === 1) {
    map.easeTo({ center: coordinates[0]!, zoom: 15, duration });
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  for (const coordinate of coordinates) bounds.extend(coordinate);
  map.fitBounds(bounds as LngLatBoundsLike, { padding: 55, maxZoom: 15, duration });
}

function routeSourceId(id: string) {
  return `route-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function liveMarker(name: string) {
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "relative h-6 w-6 cursor-pointer rounded-full border-[3px] border-white bg-amber-500 p-0 shadow-lg ring-4 ring-amber-400/40 focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-[#14213D]";
  marker.setAttribute("aria-label", `${name}, live location`);
  return marker;
}

function escape(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
