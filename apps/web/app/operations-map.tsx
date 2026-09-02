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
  const [mapUnavailable, setMapUnavailable] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: container.current,
        style: "https://tiles.openfreemap.org/styles/liberty",
        center: [67.035, 24.815],
        zoom: 12.2,
      });
    } catch {
      // Some managed browsers and remote desktops disable WebGL entirely.
      // Keep route metrics and coordinates usable instead of escalating the
      // renderer failure to the dashboard-level error boundary.
      setMapUnavailable(true);
      return;
    }
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

    try {
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
    } catch {
      setMapUnavailable(true);
    }
  }, [points, ready, routes]);

  if (mapUnavailable) return <MapFallback points={points} routes={routes} />;

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

function MapFallback({ points, routes }: { points: MapPoint[]; routes: RouteLine[] }) {
  const validPoints = points.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  const routeFixes = routes.reduce((total, route) => total + route.coordinates.length, 0);
  return <section className="relative mt-5 min-h-[350px] overflow-hidden rounded-2xl border border-[#C9D6EE] bg-[#F5F9FF] p-5 sm:min-h-[430px] sm:p-7" role="status" aria-labelledby="map-fallback-title">
    <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-44 w-full opacity-30" viewBox="0 0 700 180" preserveAspectRatio="none" aria-hidden="true">
      <path d="M-20 148 C96 18 174 174 292 86 S490 24 720 110" fill="none" stroke="#5269FF" strokeWidth="4" strokeDasharray="9 10" />
      <circle cx="106" cy="73" r="8" fill="#1FC7FF" /><circle cx="294" cy="84" r="8" fill="#FFC938" /><circle cx="536" cy="48" r="8" fill="#21B985" />
    </svg>
    <div className="relative z-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(250px,.72fr)]">
      <div>
        <span className="font-utility inline-flex rounded-full bg-[#102A58] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-white">Route data remains available</span>
        <h3 className="font-display mt-4 text-2xl font-black tracking-[-0.025em] text-[#102A58]" id="map-fallback-title">Interactive map unavailable</h3>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[#53647F]">This browser could not start its graphics renderer. Route totals, live status, and the raw GPS audit below are still working. Enable hardware acceleration to restore the interactive map.</p>
        <div className="mt-5 grid max-w-lg grid-cols-3 overflow-hidden rounded-xl border border-[#DCE4F2] bg-white/90 shadow-[0_10px_28px_rgba(16,42,88,0.06)]">
          <MapFallbackStat label="Locations" value={validPoints.length} />
          <MapFallbackStat label="Route lines" value={routes.length} />
          <MapFallbackStat label="Line fixes" value={routeFixes} />
        </div>
      </div>
      <div className="rounded-xl border border-white/80 bg-white/90 p-4 shadow-[0_12px_34px_rgba(16,42,88,0.08)] backdrop-blur-sm">
        <strong className="font-display block text-base text-[#102A58]">Saved locations</strong>
        <p className="mt-1 text-xs leading-5 text-[#667792]">Open individual coordinates without the interactive renderer.</p>
        <ul className="mt-3 divide-y divide-[#E7EDF7]">
          {validPoints.slice(0, 5).map((point) => <li className="py-2.5" key={point.id}><a className="group flex items-center justify-between gap-3 text-sm font-extrabold text-[#4056D8]" href={`https://www.openstreetmap.org/?mlat=${point.latitude}&mlon=${point.longitude}#map=18/${point.latitude}/${point.longitude}`} target="_blank" rel="noreferrer"><span className="truncate">{point.name}</span><span className="shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true">↗</span></a><small className="mt-0.5 block truncate text-[#70809A]">{point.address}</small></li>)}
          {validPoints.length === 0 && <li className="py-4 text-sm text-[#667792]">No saved coordinates for this filter.</li>}
        </ul>
      </div>
    </div>
  </section>;
}

function MapFallbackStat({ label, value }: { label: string; value: number }) {
  return <div className="border-r border-[#E3EAF5] px-3 py-3 last:border-r-0"><strong className="block text-xl font-black text-[#102A58]">{value.toLocaleString()}</strong><small className="mt-0.5 block text-[10px] font-bold uppercase tracking-[0.08em] text-[#70809A]">{label}</small></div>;
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
