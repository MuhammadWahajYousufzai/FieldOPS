// Local-only fixture for the production WebGL maps. No Appwrite connection.
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import maplibregl, { type GeoJSONSource, type Map as VectorMap } from "maplibre-gl";
import type { TerritoryBoundary } from "@fieldops/domain";
import { OperationsMap, type MapPoint, type RouteLine } from "../app/operations-map";
import { PointMapPicker, TerritoryBoundaryEditor, type SelectedPoint } from "../app/management/map-editors";
import { BrandMark } from "../app/brand-mark";

const maps = new Set<VectorMap>();
const sourceWrites = new WeakMap<GeoJSONSource, number>();
const addControl = maplibregl.Map.prototype.addControl;
maplibregl.Map.prototype.addControl = function (...args) { maps.add(this); return addControl.apply(this, args); };
const setData = maplibregl.GeoJSONSource.prototype.setData;
maplibregl.GeoJSONSource.prototype.setData = function (this: GeoJSONSource, ...args: unknown[]) { sourceWrites.set(this, (sourceWrites.get(this) ?? 0) + 1); return Reflect.apply(setData, this, args); } as typeof setData;
const activeMaps = () => [...maps].filter((map) => map.getCanvas().isConnected);

const boundary: TerritoryBoundary = { type: "Polygon", coordinates: [[[67.02,24.80],[67.06,24.80],[67.06,24.84],[67.02,24.84],[67.02,24.80]]] };
const territories = [{ id: "fixture", name: "Synthetic test area", code: "TEST", boundary }];
const baseRoutes: RouteLine[] = [
  { id: "recorded", name: "Synthetic recorded route", color: "#5269FF", coordinates: [[67.025,24.81],[67.031,24.816],[67.04,24.813]] },
  { id: "gap", name: "Synthetic GPS gap", color: "#5269FF", coordinates: [[67.04,24.813],[67.05,24.82]], estimated: true },
];
const stressRoute: RouteLine = { id: "stress", name: "10,000 synthetic fixes", color: "#5269FF", coordinates: Array.from({ length: 10_000 }, (_, index) => [67.025 + index * 0.0000025, 24.815 + Math.sin(index / 150) * 0.004]) };

function Fixture() {
  const [view, setView] = useState("routes");
  const [revision, setRevision] = useState(0);
  const [tick, setTick] = useState(0);
  const [empty, setEmpty] = useState(false);
  const [stress, setStress] = useState(false);
  const [selected, setSelected] = useState<SelectedPoint | null>(null);
  const [draft, setDraft] = useState<TerritoryBoundary | null>(null);
  const [inspection, setInspection] = useState("");
  const [benchmark, setBenchmark] = useState("");
  const points = useMemo<MapPoint[]>(() => [
    { id: "outlet", name: "Synthetic outlet", address: "Test coordinates only", kind: "outlet", latitude: 24.81, longitude: 67.025 },
    { id: "visit", name: "Synthetic visit", address: "Test coordinates only", kind: "visit", latitude: 24.813, longitude: 67.04 },
    { id: "live", name: "Synthetic live position", address: "Test coordinates only", kind: "live", latitude: 24.82 + revision * 0.001, longitude: 67.05 },
  ], [revision]);
  const routes = useMemo(() => empty ? [] : stress ? [stressRoute] : baseRoutes, [empty, stress]);

  async function inspect() {
    const map = activeMaps()[0];
    if (!map) { setInspection("No active WebGL map"); return; }
    const canvas = map.getCanvas();
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const source = map.getSource("fieldops-routes") as GeoJSONSource | undefined;
    const data = source ? await source.getData() : null;
    setInspection(JSON.stringify({ activeMaps: activeMaps().length, webgl: gl?.getParameter(gl.VERSION), styleLoaded: map.isStyleLoaded(), tilesLoaded: map.areTilesLoaded(), zoom: map.getZoom(), canvas: [canvas.width, canvas.height], routeSourceWrites: source ? sourceWrites.get(source) ?? 0 : null, features: data && typeof data !== "string" && data.type === "FeatureCollection" ? data.features.length : null, markers: document.querySelectorAll(".maplibregl-marker").length, englishLabels: map.getStyle().layers.filter((layer) => layer.type === "symbol" && JSON.stringify(layer.layout?.["text-field"]).includes("name:en")).length }));
  }

  function runBenchmark() {
    const map = activeMaps()[0];
    if (!map || !map.areTilesLoaded()) { setBenchmark("Wait for vector tiles to finish loading."); return; }
    setBenchmark("Measuring zoom…");
    const zoom = map.getZoom();
    const start = performance.now();
    let previous = start;
    const gaps: number[] = [];
    map.easeTo({ zoom: zoom + 1.2, duration: 1800 });
    function frame(now: number) {
      if (!map!.getCanvas().isConnected) { setBenchmark("Cancelled"); return; }
      gaps.push(now - previous);
      previous = now;
      if (now - start < 2000) requestAnimationFrame(frame);
      else {
        const sorted = [...gaps].sort((a, b) => a - b);
        setBenchmark(JSON.stringify({ frames: gaps.length, averageFps: Math.round(gaps.length / ((now-start)/1000)), p95FrameMs: Math.round(sorted[Math.floor(sorted.length*0.95)] ?? 0), framesOver50ms: gaps.filter((gap) => gap > 50).length }));
        map!.easeTo({ zoom, duration: 700 });
      }
    }
    requestAnimationFrame(frame);
  }

  return <main style={{ maxWidth: 1000, margin: "24px auto", padding: 20 }}>
    <header style={{ display: "flex", alignItems: "center", gap: 16 }}><BrandMark /><div><h1>Vector map regression check</h1><p>Synthetic data · real WebGL · no production writes</p></div></header>
    <nav style={{ display: "flex", gap: 12, margin: "18px 0" }}>{["routes","outlet","boundary"].map((name) => <button className="rounded border p-2" key={name} onClick={() => setView(name)}>{name}</button>)}</nav>
    {view === "routes" && <><button className="rounded border p-2" onClick={() => setRevision((value) => value + 1)}>Move live marker</button><button className="rounded border p-2" onClick={() => setEmpty((value) => !value)}>Toggle empty data</button><button className="rounded border p-2" onClick={() => setTick((value) => value + 1)}>Unchanged status tick {tick}</button><button className="rounded border p-2" onClick={() => setStress((value) => !value)}>Toggle 10,000 fixes</button><OperationsMap points={empty ? [] : points} routes={routes} /></>}
    {view === "outlet" && <><PointMapPicker territories={territories} value={selected} onChange={setSelected} /><output>Selected point: {JSON.stringify(selected)}</output></>}
    {view === "boundary" && <><TerritoryBoundaryEditor onChange={setDraft} /><output>Boundary: {JSON.stringify(draft)}</output></>}
    <button className="my-4 rounded border p-2" onClick={() => void inspect()}>Inspect rendered map</button><button className="my-4 rounded border p-2" onClick={runBenchmark}>Measure zoom performance</button>
    <pre style={{ whiteSpace: "pre-wrap" }} aria-label="Map inspection">{inspection}</pre><pre style={{ whiteSpace: "pre-wrap" }} aria-label="Zoom performance">{benchmark}</pre>
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
