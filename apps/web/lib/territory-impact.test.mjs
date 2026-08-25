import assert from "node:assert/strict";
import test from "node:test";

import { territoryBoundaryImpact } from "./territory-impact.ts";

const boundary = {
  type: "Polygon",
  coordinates: [[
    [67, 24.8],
    [67.1, 24.8],
    [67.1, 24.9],
    [67, 24.9],
    [67, 24.8],
  ]],
};

test("territory boundary impact identifies outlets that would be stranded", () => {
  const result = territoryBoundaryImpact(boundary, [
    { id: "inside", name: "Inside shop", latitude: 24.85, longitude: 67.05 },
    { id: "edge", name: "Boundary shop", latitude: 24.8, longitude: 67.05 },
    { id: "outside", name: "Outside shop", latitude: 24.85, longitude: 67.11 },
  ]);

  assert.equal(result.checked, 3);
  assert.deepEqual(result.outside.map((outlet) => outlet.id), ["outside"]);
  assert.equal(result.invalid.length, 0);
});

test("territory boundary impact fails closed for invalid legacy coordinates", () => {
  const result = territoryBoundaryImpact(boundary, [
    { id: "invalid", name: "Broken point", latitude: Number.NaN, longitude: 67.05 },
  ]);

  assert.deepEqual(result.invalid.map((outlet) => outlet.id), ["invalid"]);
  assert.equal(result.outside.length, 0);
});
