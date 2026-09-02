import type { ExpressionSpecification, MapOptions, StyleSpecification } from "maplibre-gl";

export const vectorStyleUrl = "https://tiles.openfreemap.org/styles/positron";

// OpenMapTiles provides English names and transliteration separately. Never
// concatenate the local-script name onto the English label.
export const englishMapName: ExpressionSpecification = ["coalesce",
  ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], "",
];

export function prepareVectorStyle(original: StyleSpecification): StyleSpecification {
  const style = structuredClone(original);
  style.name = "FieldOPS · English streets";
  style.layers = style.layers.filter((layer) => layer.type !== "raster" && layer.type !== "fill-extrusion");
  for (const [id, source] of Object.entries(style.sources)) {
    if (source.type === "raster" || source.type === "raster-dem") delete style.sources[id];
  }
  for (const layer of style.layers) {
    if (layer.type === "symbol" && layer.layout?.["text-field"] && /name/.test(JSON.stringify(layer.layout["text-field"]))) {
      layer.layout["text-field"] = englishMapName;
      layer.paint = { ...layer.paint, "text-color": "#53647F", "text-halo-color": "#FFFFFF", "text-halo-width": 1.3 };
    }
    if (layer.type === "background") layer.paint = { ...layer.paint, "background-color": "#F5F7FB" };
    if (layer.type === "fill" && layer.id === "water") layer.paint = { ...layer.paint, "fill-color": "#CDE6F4" };
    if (layer.type === "fill" && layer.id === "park") layer.paint = { ...layer.paint, "fill-color": "#E0EEE7" };
    if (layer.type === "fill" && layer.id === "building") layer.paint = { ...layer.paint, "fill-color": "#E5EAF2", "fill-outline-color": "#D7DFEC" };
  }
  return style;
}

export function vectorMapOptions(pixelRatio: number): Pick<MapOptions, "pixelRatio" | "canvasContextAttributes" | "fadeDuration" | "cancelPendingTileRequestsWhileZooming"> {
  return {
    pixelRatio: Math.min(2, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1)),
    canvasContextAttributes: { antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false },
    fadeDuration: 150,
    // Retain parent tiles while finer vector tiles load during a zoom.
    cancelPendingTileRequestsWhileZooming: false,
  };
}
