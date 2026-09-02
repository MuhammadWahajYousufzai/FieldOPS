"use client";

import { pointInTerritory, type LngLat, type TerritoryBoundary } from "@fieldops/domain";
import maplibregl from "maplibre-gl";
import type { GeoJSONSourceSpecification, LngLatBoundsLike } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { ui } from "../ui";

export type TerritoryMapOption = { id: string; name: string; code: string; boundary: TerritoryBoundary | null };
export type SelectedPoint = { latitude: number; longitude: number };

const styleUrl = "https://tiles.openfreemap.org/styles/liberty";
const karachiCenter: LngLat = [67.035, 24.815];

export function PointMapPicker({ territories, selectedTerritoryId, value, onChange }: {
  territories: TerritoryMapOption[];
  selectedTerritoryId: string;
  value: SelectedPoint | null;
  onChange: (point: SelectedPoint) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const changeRef = useRef(onChange);
  const territoriesRef = useRef(territories);
  const selectedTerritoryRef = useRef(selectedTerritoryId);
  const selectPointRef = useRef<(point: SelectedPoint) => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  changeRef.current = onChange;
  territoriesRef.current = territories;
  selectedTerritoryRef.current = selectedTerritoryId;
  selectPointRef.current = (point) => {
    const territory = territoriesRef.current.find((item) => item.id === selectedTerritoryRef.current);
    if (!territory) {
      setSelectionError("Choose a sales area before placing the outlet.");
      return;
    }
    if (!territory.boundary) {
      setSelectionError(`Draw and save ${territory.name}'s boundary before placing an outlet.`);
      return;
    }
    if (!pointInTerritory(point, territory.boundary)) {
      setSelectionError(`That point is outside ${territory.name}. Choose a point inside the shaded boundary.`);
      return;
    }
    setSelectionError("");
    changeRef.current(point);
  };

  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({ container: container.current, style: styleUrl, center: karachiCenter, zoom: 11.8 });
    } catch {
      setMapUnavailable(true);
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("click", (event) => selectPointRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }));
    map.on("load", () => setReady(true));
    return () => { markerRef.current?.remove(); mapRef.current = null; map.remove(); };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const territory of territories) {
      if (!territory.boundary) continue;
      const sourceId = mapId("outlet-territory", territory.id);
      const existing = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (existing) existing.setData(territory.boundary as GeoJSONSourceSpecification["data"]);
      else map.addSource(sourceId, { type: "geojson", data: territory.boundary as GeoJSONSourceSpecification["data"] });
      if (!map.getLayer(`${sourceId}-fill`)) map.addLayer({ id: `${sourceId}-fill`, type: "fill", source: sourceId, paint: { "fill-color": "#243d74", "fill-opacity": territory.id === selectedTerritoryId ? 0.2 : 0.06 } });
      if (!map.getLayer(`${sourceId}-line`)) map.addLayer({ id: `${sourceId}-line`, type: "line", source: sourceId, paint: { "line-color": territory.id === selectedTerritoryId ? "#243d74" : "#8792a8", "line-width": territory.id === selectedTerritoryId ? 3 : 1.5 } });
    }
  }, [ready, territories]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const territory of territories) {
      if (!territory.boundary) continue;
      const sourceId = mapId("outlet-territory", territory.id);
      if (!map.getLayer(`${sourceId}-fill`)) continue;
      const selected = territory.id === selectedTerritoryId;
      map.setPaintProperty(`${sourceId}-fill`, "fill-opacity", selected ? 0.2 : 0.06);
      map.setPaintProperty(`${sourceId}-line`, "line-color", selected ? "#243d74" : "#8792a8");
      map.setPaintProperty(`${sourceId}-line`, "line-width", selected ? 3 : 1.5);
    }
    const selected = territories.find((territory) => territory.id === selectedTerritoryId && territory.boundary);
    if (selected?.boundary) fitBoundary(map, selected.boundary);
    setSelectionError("");
  }, [ready, selectedTerritoryId, territories]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) markerRef.current = new maplibregl.Marker({ color: "#d8a629" }).addTo(map);
    markerRef.current.setLngLat([value.longitude, value.latitude]);
  }, [ready, value]);

  return <div className="grid gap-3">
    {mapUnavailable
      ? <MapEditorUnavailable title="Outlet map unavailable" detail="This browser could not start its graphics renderer. The saved outlet point is unchanged; enable hardware acceleration to choose a different point." />
      : <div className="h-[300px] w-full overflow-hidden rounded-2xl border border-slate-300 bg-slate-200 focus-within:ring-3 focus-within:ring-blue-200 sm:h-[360px]" ref={container} role="application" aria-label="Outlet map picker. Click the map or move it and use the center button to select a visit point." />}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={ui.quietButton} disabled={mapUnavailable} onClick={() => { const center = mapRef.current?.getCenter(); if (center) selectPointRef.current({ latitude: center.lat, longitude: center.lng }); }}>Use map center</button>
      <span className="text-xs font-bold text-slate-500" aria-live="polite">{value ? `${value.latitude.toFixed(6)}, ${value.longitude.toFixed(6)} selected` : "No visit point selected"}</span>
    </div>
    {selectionError && <p className={ui.messageError} role="alert">{selectionError}</p>}
  </div>;
}

export function TerritoryBoundaryEditor({ initialBoundary = null, onChange }: {
  initialBoundary?: TerritoryBoundary | null;
  onChange: (boundary: TerritoryBoundary | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pointsRef = useRef<LngLat[]>(initialBoundary?.coordinates[0]?.slice(0, -1) ?? []);
  const [points, setPoints] = useState<LngLat[]>(pointsRef.current);
  const [ready, setReady] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);

  function update(next: LngLat[]) {
    pointsRef.current = next;
    setPoints(next);
    onChange(toBoundary(next));
  }

  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({ container: container.current, style: styleUrl, center: karachiCenter, zoom: 11.5 });
    } catch {
      setMapUnavailable(true);
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("click", (event) => update([...pointsRef.current, [event.lngLat.lng, event.lngLat.lat]]));
    map.on("load", () => {
      map.addSource("territory-draft", { type: "geojson", data: draftFeature(pointsRef.current) });
      map.addLayer({ id: "territory-draft-fill", type: "fill", source: "territory-draft", paint: { "fill-color": "#267057", "fill-opacity": 0.2 } });
      map.addLayer({ id: "territory-draft-line", type: "line", source: "territory-draft", paint: { "line-color": "#267057", "line-width": 3 } });
      map.addLayer({ id: "territory-draft-points", type: "circle", source: "territory-draft", paint: { "circle-color": "#d8a629", "circle-radius": 6, "circle-stroke-color": "#17233b", "circle-stroke-width": 2 } });
      setReady(true);
      const boundary = toBoundary(pointsRef.current);
      if (boundary) fitBoundary(map, boundary);
    });
    return () => { mapRef.current = null; map.remove(); };
  }, []);

  useEffect(() => {
    const source = mapRef.current?.getSource("territory-draft") as maplibregl.GeoJSONSource | undefined;
    if (ready && source) source.setData(draftFeature(points));
  }, [points, ready]);

  return <div className="grid gap-3">
    {mapUnavailable
      ? <MapEditorUnavailable title="Sales-area map unavailable" detail="This browser could not start its graphics renderer. The saved boundary is unchanged; enable hardware acceleration before drawing or revising it." />
      : <div className="h-[300px] w-full overflow-hidden rounded-2xl border border-slate-300 bg-slate-200 focus-within:ring-3 focus-within:ring-blue-200 sm:h-[360px]" ref={container} role="application" aria-label="Sales area boundary editor. Click to add boundary points. At least three points are required." />}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={ui.quietButton} disabled={mapUnavailable || points.length === 0} onClick={() => update(points.slice(0, -1))}>Undo point</button>
      <button type="button" className={ui.dangerButton} disabled={mapUnavailable || points.length === 0} onClick={() => update([])}>Clear</button>
      <button type="button" className={ui.quietButton} disabled={mapUnavailable} onClick={() => { const center = mapRef.current?.getCenter(); if (center) update([...points, [center.lng, center.lat]]); }}>Add map center</button>
      <span className="text-xs font-bold text-slate-500" aria-live="polite">{points.length < 3 ? `${points.length}/3 points · add ${3 - points.length} more` : `${points.length} points · boundary ready`}</span>
    </div>
  </div>;
}

function MapEditorUnavailable({ title, detail }: { title: string; detail: string }) {
  return <div className="relative grid min-h-[300px] place-content-center overflow-hidden rounded-2xl border border-[#C9D6EE] bg-[#F5F9FF] p-6 text-center sm:min-h-[360px]" role="status">
    <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-32 w-full opacity-25" viewBox="0 0 700 150" preserveAspectRatio="none" aria-hidden="true"><path d="M-20 118 C110 24 198 140 322 65 S520 28 720 92" fill="none" stroke="#5269FF" strokeWidth="4" strokeDasharray="9 10" /><circle cx="120" cy="66" r="7" fill="#1FC7FF" /><circle cx="323" cy="64" r="7" fill="#FFC938" /><circle cx="548" cy="43" r="7" fill="#21B985" /></svg>
    <div className="relative z-10 mx-auto max-w-lg"><span className="font-utility inline-flex rounded-full bg-[#102A58] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-white">Saved geography protected</span><h3 className="font-display mt-4 text-xl font-black text-[#102A58]">{title}</h3><p className="mt-2 text-sm leading-6 text-[#53647F]">{detail}</p></div>
  </div>;
}

function toBoundary(points: LngLat[]): TerritoryBoundary | null {
  if (points.length < 3) return null;
  return { type: "Polygon", coordinates: [[...points, points[0]!]] };
}

function draftFeature(points: LngLat[]): GeoJSONSourceSpecification["data"] {
  if (points.length >= 3) return toBoundary(points)!;
  if (points.length === 2) return { type: "LineString", coordinates: points };
  return { type: "MultiPoint", coordinates: points };
}

function fitBoundary(map: maplibregl.Map, boundary: TerritoryBoundary) {
  const bounds = new maplibregl.LngLatBounds();
  for (const point of boundary.coordinates[0] ?? []) bounds.extend(point);
  if (!bounds.isEmpty()) map.fitBounds(bounds as LngLatBoundsLike, { padding: 48, maxZoom: 15, duration: 250 });
}

function mapId(prefix: string, id: string) {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
