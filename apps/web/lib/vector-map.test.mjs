import test from "node:test";
import assert from "node:assert/strict";
import { prepareVectorStyle, englishMapName, vectorMapOptions } from "./vector-map-style.ts";
import { buildMapRoutes } from "./map-route-data.ts";

test("English vector labels replace bilingual names but preserve road numbers", () => {
  const original = { version: 8, sources: { streets: { type: "vector", url: "https://example.com/tiles" }, terrain: { type: "raster", tiles: [] } }, layers: [
    { id: "name", type: "symbol", layout: { "text-field": ["concat", ["get", "name:latin"], " ", ["get", "name:nonlatin"]] } },
    { id: "shield", type: "symbol", layout: { "text-field": ["get", "ref"] } },
    { id: "raster", type: "raster", source: "terrain" },
  ] };
  const style = prepareVectorStyle(original);
  assert.deepEqual(style.layers[0].layout["text-field"], englishMapName);
  assert.deepEqual(style.layers[1].layout["text-field"], ["get", "ref"]);
  assert.equal(style.layers.length, 2);
  assert.equal(style.sources.terrain, undefined);
  assert.equal(original.layers.length, 3);
  assert.doesNotMatch(JSON.stringify(englishMapName), /nonlatin|\["get","name"\]/);
});

test("vector rendering caps pixel workload and retains parent tiles during zoom", () => {
  assert.equal(vectorMapOptions(4).pixelRatio, 2);
  assert.equal(vectorMapOptions(1).pixelRatio, 1);
  assert.equal(vectorMapOptions(NaN).pixelRatio, 1);
  assert.equal(vectorMapOptions(2).canvasContextAttributes.preserveDrawingBuffer, false);
  assert.equal(vectorMapOptions(2).cancelPendingTileRequestsWhileZooming, false);
});

test("GPU route collection preserves gap semantics, colors and invalid-fix splits", () => {
  const routes = buildMapRoutes([
    { id: "recorded", name: "Route", color: "#5269FF", coordinates: [[67,24],[67.1,24.1],[NaN,24],[67.2,24.2],[67.3,24.3]] },
    { id: "gap", name: "Gap", color: "#5269FF", estimated: true, coordinates: [[67.3,24.3],[67.4,24.4]] },
  ]);
  assert.equal(routes.features.length, 2);
  assert.equal(routes.features[0].geometry.coordinates.length, 2);
  assert.equal(routes.features[0].properties.estimated, false);
  assert.equal(routes.features[1].properties.estimated, true);
  assert.deepEqual(routes.features[0].geometry.coordinates[0][0], [67,24]);
  assert.deepEqual(buildMapRoutes([]).features, []);
});
