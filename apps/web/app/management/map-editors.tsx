"use client";

import { pointInTerritory, type LngLat, type TerritoryBoundary } from "@fieldops/domain";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { validMapCoordinate } from "../../lib/map-coordinates";
import { MapStatus } from "../map-status";
import { useVectorMap, type VectorMapContext } from "../use-vector-map";
import { ui } from "../ui";

export type TerritoryMapOption = { id: string; name: string; code: string; boundary: TerritoryBoundary | null };
export type SelectedPoint = { latitude: number; longitude: number };

export function PointMapPicker({ territories, selectedTerritoryId, value, onChange }: {
  territories: TerritoryMapOption[];
  selectedTerritoryId: string;
  value: SelectedPoint | null;
  onChange: (point: SelectedPoint) => void;
}) {
  const { container, context, error, retry } = useVectorMap();
  const [selectionError, setSelectionError] = useState("");
  const selectPoint = useRef<(point: SelectedPoint) => void>(() => undefined);
  const lastFit = useRef("");
  selectPoint.current = (point) => {
    const territory = territories.find((item) => item.id === selectedTerritoryId);
    if (!territory) { setSelectionError("Choose a sales area before placing the outlet."); return; }
    if (!territory.boundary) { setSelectionError(`Draw and save ${territory.name}'s boundary before placing an outlet.`); return; }
    if (!pointInTerritory(point, territory.boundary)) { setSelectionError(`That point is outside ${territory.name}. Choose a point inside the shaded boundary.`); return; }
    setSelectionError("");
    onChange(point);
  };

  useEffect(() => {
    if (!context) return;
    lastFit.current = "";
    const click = (event: import("maplibre-gl").MapMouseEvent) => selectPoint.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
    context.map.on("click", click);
    return () => { context.map.off("click", click); };
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const { map } = context;
    const data = { type: "FeatureCollection" as const, features: territories.flatMap((territory) => territory.boundary ? [{ type: "Feature" as const, properties: { id: territory.id }, geometry: territory.boundary }] : []) };
    const source = map.getSource("fieldops-territories") as GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
      map.addSource("fieldops-territories", { type: "geojson", data });
      map.addLayer({ id: "fieldops-territories-fill", type: "fill", source: "fieldops-territories", paint: { "fill-color": "#5269FF", "fill-opacity": 0.12 } });
      map.addLayer({ id: "fieldops-territories-line", type: "line", source: "fieldops-territories", paint: { "line-color": "#5269FF", "line-width": 2 } });
    }
    map.setPaintProperty("fieldops-territories-fill", "fill-opacity", ["case", ["==", ["get", "id"], selectedTerritoryId], 0.18, 0.04]);
    map.setPaintProperty("fieldops-territories-line", "line-color", ["case", ["==", ["get", "id"], selectedTerritoryId], "#4056D8", "#A8B4C9"]);
    const selected = territories.find((territory) => territory.id === selectedTerritoryId);
    const fitKey = JSON.stringify([selectedTerritoryId, selected?.boundary]);
    if (fitKey !== lastFit.current) {
      if (selected?.boundary) fitBoundary(context, selected.boundary);
      lastFit.current = fitKey;
      setSelectionError("");
    }
  }, [context, territories, selectedTerritoryId]);

  useEffect(() => {
    if (!context || !value || !validMapCoordinate([value.longitude, value.latitude])) return;
    const { map, lib } = context;
    const marker = new lib.Marker({ color: "#D8A629" }).setLngLat([value.longitude, value.latitude]).addTo(map);
    marker.getElement().setAttribute("aria-label", "Selected outlet location");
    return () => { marker.remove(); };
  }, [context, value]);

  return <div className="grid gap-3">
    <div className="relative isolate overflow-hidden rounded-2xl border border-slate-300">
      <div className="h-[300px] w-full bg-[#F5F7FB] sm:h-[360px]" ref={container} role="region" aria-label="Outlet map picker. Click the map or use the center button to select a visit point." />
      <MapStatus ready={Boolean(context)} error={error} retry={retry} />
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={ui.quietButton} disabled={!context} onClick={() => { const center = context?.map.getCenter(); if (center) selectPoint.current({ latitude: center.lat, longitude: center.lng }); }}>Use map center</button>
      <span className="text-xs font-bold text-slate-500" aria-live="polite">{value ? `${value.latitude.toFixed(6)}, ${value.longitude.toFixed(6)} selected` : "No visit point selected"}</span>
    </div>
    {selectionError && <p className={ui.messageError} role="alert">{selectionError}</p>}
  </div>;
}

export function TerritoryBoundaryEditor({ initialBoundary = null, onChange }: {
  initialBoundary?: TerritoryBoundary | null;
  onChange: (boundary: TerritoryBoundary | null) => void;
}) {
  const { container, context, error, retry } = useVectorMap({ drawing: true });
  const [points, setPoints] = useState<LngLat[]>(() => initialBoundary?.coordinates[0]?.slice(0, -1) ?? []);
  const pointsRef = useRef(points);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialBoundaryRef = useRef(initialBoundary);

  function update(next: LngLat[]) {
    pointsRef.current = next;
    setPoints(next);
    onChangeRef.current(toBoundary(next));
  }

  useEffect(() => {
    if (!context) return;
    const click = (event: import("maplibre-gl").MapMouseEvent) => update([...pointsRef.current, [event.lngLat.lng, event.lngLat.lat]]);
    context.map.on("click", click);
    if (initialBoundaryRef.current) fitBoundary(context, initialBoundaryRef.current);
    return () => { context.map.off("click", click); };
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const { map } = context;
    const coordinates = points.filter(validMapCoordinate);
    const geometry = coordinates.length >= 3 ? toBoundary(coordinates)! : { type: "LineString" as const, coordinates: coordinates.length === 2 ? coordinates : [] };
    const data = { type: "FeatureCollection" as const, features: [
      ...(coordinates.length >= 2 ? [{ type: "Feature" as const, properties: {}, geometry }] : []),
      ...coordinates.map((point) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: point } })),
    ] };
    const source = map.getSource("fieldops-boundary") as GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
      map.addSource("fieldops-boundary", { type: "geojson", data });
      map.addLayer({ id: "fieldops-boundary-fill", type: "fill", source: "fieldops-boundary", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#21B985", "fill-opacity": 0.18 } });
      map.addLayer({ id: "fieldops-boundary-line", type: "line", source: "fieldops-boundary", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#267057", "line-width": 3 } });
      map.addLayer({ id: "fieldops-boundary-points", type: "circle", source: "fieldops-boundary", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 6, "circle-color": "#FFC938", "circle-stroke-color": "#102A58", "circle-stroke-width": 2 } });
    }
  }, [context, points]);

  return <div className="grid gap-3">
    <div className="relative isolate overflow-hidden rounded-2xl border border-slate-300">
      <div className="h-[300px] w-full bg-[#F5F7FB] sm:h-[360px]" ref={container} role="region" aria-label="Sales area boundary editor. Click to add boundary points. At least three points are required." />
      <MapStatus ready={Boolean(context)} error={error} retry={retry} />
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={ui.quietButton} disabled={points.length === 0} onClick={() => update(points.slice(0, -1))}>Undo point</button>
      <button type="button" className={ui.dangerButton} disabled={points.length === 0} onClick={() => update([])}>Clear</button>
      <button type="button" className={ui.quietButton} disabled={!context} onClick={() => { const center = context?.map.getCenter(); if (center) update([...points, [center.lng, center.lat]]); }}>Add map center</button>
      <span className="text-xs font-bold text-slate-500" aria-live="polite">{points.length < 3 ? `${points.length}/3 points · add ${3 - points.length} more` : `${points.length} points · boundary ready`}</span>
    </div>
  </div>;
}

function toBoundary(points: LngLat[]): TerritoryBoundary | null {
  if (points.length < 3) return null;
  return { type: "Polygon", coordinates: [[...points, points[0]!]] };
}

function fitBoundary({ map, lib }: VectorMapContext, boundary: TerritoryBoundary) {
  const coordinates = boundary.coordinates[0]?.filter(validMapCoordinate) ?? [];
  const bounds = new lib.LngLatBounds();
  for (const point of coordinates) bounds.extend(point);
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
}
