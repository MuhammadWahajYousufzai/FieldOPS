"use client";

import maplibregl from "maplibre-gl";
import type { LngLatBoundsLike } from "maplibre-gl";
import { useEffect, useRef } from "react";

export type MapPoint = {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  kind: "outlet" | "visit" | "live";
};

export function OperationsMap({ points }: { points: MapPoint[] }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [67.035, 24.815],
      zoom: 12.2,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const bounds = new maplibregl.LngLatBounds();
    for (const point of points) {
      const color = point.kind === "visit" ? "#267057" : point.kind === "live" ? "#d8a629" : "#243d74";
      new maplibregl.Marker({ color })
        .setLngLat([point.longitude, point.latitude])
        .setPopup(new maplibregl.Popup({ offset: 24 }).setHTML(`<strong>${escape(point.name)}</strong><br><span>${escape(point.address)}</span>`))
        .addTo(map);
      bounds.extend([point.longitude, point.latitude]);
    }
    if (points.length > 1) map.fitBounds(bounds as LngLatBoundsLike, { padding: 55, maxZoom: 14, duration: 0 });
    return () => map.remove();
  }, [points]);
  return <div className="operations-map" ref={container} aria-label="Map of assigned outlets and captured visit locations" />;
}

function escape(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
