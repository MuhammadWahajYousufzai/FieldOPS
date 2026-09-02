"use client";

import type { Map as LeafletMap } from "leaflet";
import { useEffect, useRef, useState } from "react";

export type LeafletContext = { map: LeafletMap; leaflet: typeof import("leaflet") };

export function useLeafletMap({ drawing = false } = {}) {
  const container = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<LeafletContext | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let cancelled = false;
    let map: LeafletMap | undefined;
    let resize: ResizeObserver | undefined;
    setError(false);
    setContext(null);

    // Leaflet touches window during import. Load only after mounting, never
    // during server rendering. Raster tiles + SVG do not need a WebGL context.
    void import("leaflet").then((leaflet) => {
      if (cancelled) return;
      map = leaflet.map(element, {
        center: [24.815, 67.035], zoom: 12, zoomControl: false,
        preferCanvas: false, doubleClickZoom: !drawing,
        zoomAnimation: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      });
      leaflet.control.zoom({ position: "topright" }).addTo(map);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        // Only request the visible viewport; use normal browser HTTP caching.
        keepBuffer: 1, updateWhenIdle: true,
      }).addTo(map);
      resize = new ResizeObserver(() => map?.invalidateSize({ pan: false }));
      resize.observe(element);
      setContext({ map, leaflet });
    }).catch((cause: unknown) => {
      if (cancelled) return;
      console.error("FieldOPS map initialization failed", cause);
      resize?.disconnect();
      map?.remove();
      map = undefined;
      setError(true);
    });

    return () => {
      cancelled = true;
      resize?.disconnect();
      map?.remove();
    };
  }, [attempt, drawing]);

  return { container, context, error, retry: () => setAttempt((value) => value + 1) };
}
