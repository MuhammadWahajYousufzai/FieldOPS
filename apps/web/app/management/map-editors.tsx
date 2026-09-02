"use client";

import { pointInTerritory, type LngLat, type TerritoryBoundary } from "@fieldops/domain";
import { useEffect, useRef, useState } from "react";
import { toLeafletCoordinate, validMapCoordinate } from "../../lib/map-coordinates";
import { useLeafletMap, type LeafletContext } from "../use-leaflet-map";
import { ui } from "../ui";

export type TerritoryMapOption = { id: string; name: string; code: string; boundary: TerritoryBoundary | null };
export type SelectedPoint = { latitude: number; longitude: number };

export function PointMapPicker({ territories, selectedTerritoryId, value, onChange }: {
  territories: TerritoryMapOption[];
  selectedTerritoryId: string;
  value: SelectedPoint | null;
  onChange: (point: SelectedPoint) => void;
}) {
  const { container, context, error, retry } = useLeafletMap();
  const [selectionError, setSelectionError] = useState("");
  const selectPoint = useRef<(point: SelectedPoint) => void>(() => undefined);
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
    const click = (event: import("leaflet").LeafletMouseEvent) => selectPoint.current({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    context.map.on("click", click);
    return () => { context.map.off("click", click); };
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const { map, leaflet } = context;
    const group = leaflet.layerGroup().addTo(map);
    for (const territory of territories) {
      if (!territory.boundary) continue;
      const selected = territory.id === selectedTerritoryId;
      leaflet.geoJSON(territory.boundary, { interactive: false, style: { color: selected ? "#243d74" : "#8792a8", weight: selected ? 3 : 1.5, fillColor: "#243d74", fillOpacity: selected ? 0.2 : 0.06 } }).addTo(group);
    }
    return () => { group.remove(); };
  }, [context, territories, selectedTerritoryId]);

  useEffect(() => {
    if (!context) return;
    const selected = territories.find((territory) => territory.id === selectedTerritoryId);
    if (selected?.boundary) fitBoundary(context, selected.boundary);
    setSelectionError("");
  }, [context, selectedTerritoryId, territories]);

  useEffect(() => {
    if (!context || !value || !validMapCoordinate([value.longitude, value.latitude])) return;
    const { map, leaflet } = context;
    const icon = leaflet.divIcon({ className: "fieldops-map-marker fieldops-map-marker--live", html: '<span aria-hidden="true"></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
    const marker = leaflet.marker([value.latitude, value.longitude], { icon, title: "Selected outlet location", alt: "Selected outlet location" }).addTo(map);
    return () => { marker.remove(); };
  }, [context, value]);

  return <div className="grid gap-3">
    <div className="relative isolate overflow-hidden rounded-2xl border border-slate-300">
      <div className="h-[300px] w-full bg-slate-100 sm:h-[360px]" ref={container} role="region" aria-label="Outlet map picker. Click the map or use the center button to select a visit point." />
      {!context && <MapLoading error={error} retry={retry} />}
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
  const { container, context, error, retry } = useLeafletMap({ drawing: true });
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
    const click = (event: import("leaflet").LeafletMouseEvent) => update([...pointsRef.current, [event.latlng.lng, event.latlng.lat]]);
    context.map.on("click", click);
    if (initialBoundaryRef.current) fitBoundary(context, initialBoundaryRef.current);
    return () => { context.map.off("click", click); };
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const { map, leaflet } = context;
    const group = leaflet.layerGroup().addTo(map);
    const coordinates = points.filter(validMapCoordinate).map(toLeafletCoordinate);
    if (coordinates.length >= 3) leaflet.polygon(coordinates, { color: "#267057", weight: 3, fillOpacity: 0.2, interactive: false, className: "fieldops-boundary" }).addTo(group);
    else if (coordinates.length === 2) leaflet.polyline(coordinates, { color: "#267057", weight: 3, interactive: false }).addTo(group);
    for (const coordinate of coordinates) leaflet.circleMarker(coordinate, { radius: 6, color: "#17233b", weight: 2, fillColor: "#d8a629", fillOpacity: 1, interactive: false }).addTo(group);
    return () => { group.remove(); };
  }, [context, points]);

  return <div className="grid gap-3">
    <div className="relative isolate overflow-hidden rounded-2xl border border-slate-300">
      <div className="h-[300px] w-full bg-slate-100 sm:h-[360px]" ref={container} role="region" aria-label="Sales area boundary editor. Click to add boundary points. At least three points are required." />
      {!context && <MapLoading error={error} retry={retry} />}
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={ui.quietButton} disabled={points.length === 0} onClick={() => update(points.slice(0, -1))}>Undo point</button>
      <button type="button" className={ui.dangerButton} disabled={points.length === 0} onClick={() => update([])}>Clear</button>
      <button type="button" className={ui.quietButton} disabled={!context} onClick={() => { const center = context?.map.getCenter(); if (center) update([...points, [center.lng, center.lat]]); }}>Add map center</button>
      <span className="text-xs font-bold text-slate-500" aria-live="polite">{points.length < 3 ? `${points.length}/3 points · add ${3 - points.length} more` : `${points.length} points · boundary ready`}</span>
    </div>
  </div>;
}

function MapLoading({ error, retry }: { error: boolean; retry: () => void }) {
  return <div className="absolute inset-0 z-[1000] grid place-content-center bg-slate-50/95 p-6 text-center" role="status"><p className="font-bold">{error ? "The map could not load. Please retry." : "Loading street map…"}</p>{error && <button type="button" className={ui.quietButton} onClick={retry}>Retry map</button>}</div>;
}

function toBoundary(points: LngLat[]): TerritoryBoundary | null {
  if (points.length < 3) return null;
  return { type: "Polygon", coordinates: [[...points, points[0]!]] };
}

function fitBoundary({ map, leaflet }: LeafletContext, boundary: TerritoryBoundary) {
  const coordinates = boundary.coordinates[0]?.filter(validMapCoordinate).map(toLeafletCoordinate) ?? [];
  if (coordinates.length) map.fitBounds(leaflet.latLngBounds(coordinates), { padding: [48, 48], maxZoom: 15, animate: false });
}
