"use client";

import type { Map as VectorMap, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { prepareVectorStyle, vectorMapOptions, vectorStyleUrl } from "../lib/vector-map-style";

export type VectorMapContext = { map: VectorMap; lib: typeof import("maplibre-gl") };

export function useVectorMap({ drawing = false } = {}) {
  const container = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<VectorMapContext | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const controller = new AbortController();
    let map: VectorMap | undefined;
    let cancelled = false;
    setContext(null);
    setError("");
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    // Import after mounting, so SSR and Strict Mode never create a stray canvas.
    void Promise.all([
      import("maplibre-gl"),
      fetch(vectorStyleUrl, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`Map style returned ${response.status}`);
        return prepareVectorStyle(await response.json() as StyleSpecification);
      }),
    ]).then(([module, style]) => {
      window.clearTimeout(timeout);
      if (cancelled) return;
      const lib = module.default;
      const options = { container: element, style, center: [67.035, 24.815] as [number, number], zoom: 12.2, doubleClickZoom: !drawing, ...vectorMapOptions(window.devicePixelRatio) };
      try {
        map = new lib.Map(options);
      } catch (primaryError) {
        // A dual-GPU device can refuse a high-performance context. Retry using
        // the browser's default GPU, still with WebGL2/WebGL1 negotiation.
        element.replaceChildren();
        try { map = new lib.Map({ ...options, canvasContextAttributes: { ...options.canvasContextAttributes, powerPreference: "default" } }); }
        catch { element.replaceChildren(); throw primaryError; }
      }
      map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => { if (!cancelled && map) { setContext({ map, lib }); setError(""); } });
      map.on("webglcontextlost", () => { if (!cancelled) setError("The graphics context was interrupted. Waiting for the map to recover…"); });
      map.on("webglcontextrestored", () => { if (!cancelled) setError(""); });
      map.on("error", (event) => {
        console.error("FieldOPS vector map", event.error);
        // A missing individual tile must not tear down an otherwise working map.
        if (!cancelled && !map?.isStyleLoaded()) setError("Some map resources could not load. Check the connection and retry.");
      });
    }).catch((cause: unknown) => {
      window.clearTimeout(timeout);
      if (cancelled) return;
      console.error("FieldOPS vector map initialization", cause);
      setError(cause instanceof Error && /WebGL/i.test(cause.message)
        ? "The WebGL renderer could not start. Retry the map. If it continues, the browser’s graphics report can identify the failure."
        : "The vector map could not load. Check the connection and retry.");
    });

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
      map?.remove();
    };
  }, [attempt, drawing]);

  return { container, context, error, retry: () => setAttempt((value) => value + 1) };
}
