import test from "node:test";
import assert from "node:assert/strict";
import { validMapCoordinate, toLeafletCoordinate, leafletRouteSegments } from "./map-coordinates.ts";

test("map coordinates preserve GeoJSON longitude/latitude and convert once for Leaflet", () => {
  assert.deepEqual(toLeafletCoordinate([67.035, 24.815]), [24.815, 67.035]);
  assert.equal(validMapCoordinate([67.035, 24.815]), true);
  for (const point of [[181, 20], [67, 91], [NaN, 20], [67, Infinity], ["67", 24], null, [1]]) assert.equal(validMapCoordinate(point), false);
});

test("route rendering preserves reliable segment ordering", () => {
  assert.deepEqual(leafletRouteSegments([[67, 24], [67.1, 24.1], [67.2, 24.2]]), [[[24, 67], [24.1, 67.1], [24.2, 67.2]]]);
});

test("invalid fixes split route geometry without bridging an unknown gap", () => {
  assert.deepEqual(leafletRouteSegments([[67, 24], [67.1, 24.1], [NaN, 24], [67.2, 24.2], [67.3, 24.3]]), [[[24, 67], [24.1, 67.1]], [[24.2, 67.2], [24.3, 67.3]]]);
  assert.deepEqual(leafletRouteSegments([[67, 24], [NaN, 24], [67.2, 24.2]]), []);
  assert.deepEqual(leafletRouteSegments([]), []);
});
