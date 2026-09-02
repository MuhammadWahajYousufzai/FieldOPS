// Local-only browser regression fixture. It is not a Next.js route and never
// connects to Appwrite. All geography below is synthetic test data.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TerritoryBoundary } from "@fieldops/domain";
import { OperationsMap, type MapPoint, type RouteLine } from "../app/operations-map";
import { PointMapPicker, TerritoryBoundaryEditor, type SelectedPoint } from "../app/management/map-editors";
import { BrandMark } from "../app/brand-mark";

const originalContext = HTMLCanvasElement.prototype.getContext;
let webglRequests = 0;
HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: unknown) {
  if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") { webglRequests += 1; return null; }
  return originalContext.call(this, type as "2d", options);
} as typeof originalContext;

const boundary: TerritoryBoundary = { type: "Polygon", coordinates: [[[67.02, 24.80], [67.06, 24.80], [67.06, 24.84], [67.02, 24.84], [67.02, 24.80]]] };
const territories = [{ id: "fixture", name: "Synthetic test area", code: "TEST", boundary }];
const routes: RouteLine[] = [
  { id: "recorded", name: "Synthetic recorded route", color: "#5269FF", coordinates: [[67.025,24.81],[67.031,24.816],[67.04,24.813]] },
  { id: "gap", name: "Synthetic GPS gap", color: "#5269FF", coordinates: [[67.04,24.813],[67.05,24.82]], estimated: true },
];

function Fixture() {
  const [view, setView] = useState("routes");
  const [revision, setRevision] = useState(0);
  const [empty, setEmpty] = useState(false);
  const [selected, setSelected] = useState<SelectedPoint | null>(null);
  const [draft, setDraft] = useState<TerritoryBoundary | null>(null);
  const [inspection, setInspection] = useState("");
  const points: MapPoint[] = [
    { id: "outlet", name: "Synthetic outlet", address: "Test coordinates only", kind: "outlet", latitude: 24.81, longitude: 67.025 },
    { id: "visit", name: "Synthetic visit", address: "Test coordinates only", kind: "visit", latitude: 24.813, longitude: 67.04 },
    { id: "live", name: "Synthetic live position", address: "Test coordinates only", kind: "live", latitude: 24.82 + revision * 0.001, longitude: 67.05 },
  ];
  return <main style={{maxWidth: 1000, margin: "24px auto", padding: 20}}>
    <header style={{display:"flex",alignItems:"center",gap:16}}><BrandMark /><div><h1>Map regression check</h1><p>Synthetic data · WebGL deliberately disabled · no production writes</p></div></header>
    <nav style={{display:"flex",gap:12,margin:"18px 0"}}>{["routes", "outlet", "boundary"].map((name) => <button className="rounded border p-2" key={name} onClick={() => setView(name)}>{name}</button>)}</nav>
    {view === "routes" && <><button className="rounded border p-2" onClick={() => setRevision((value) => value + 1)}>Move live marker</button><button className="rounded border p-2" onClick={() => setEmpty((value) => !value)}>Toggle empty data</button><OperationsMap points={empty ? [] : points} routes={empty ? [] : routes} /></>}
    {view === "outlet" && <><PointMapPicker territories={territories} selectedTerritoryId="fixture" value={selected} onChange={setSelected} /><output>Selected point: {JSON.stringify(selected)}</output></>}
    {view === "boundary" && <><TerritoryBoundaryEditor onChange={setDraft} /><output>Boundary: {JSON.stringify(draft)}</output></>}
    <button className="my-4 rounded border p-2" onClick={() => setInspection(JSON.stringify({webglRequests, loadedTiles: document.querySelectorAll(".leaflet-tile-loaded").length, recordedPaths: document.querySelectorAll(".fieldops-route-recorded").length, estimatedPaths: document.querySelectorAll(".fieldops-route-estimated").length, markers: document.querySelectorAll(".fieldops-map-marker").length, boundaryPolygons: document.querySelectorAll(".fieldops-boundary").length, canvases: document.querySelectorAll("canvas").length}))}>Inspect rendered map</button>
    <pre aria-label="Map inspection">{inspection}</pre>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
