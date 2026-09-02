import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../app/fieldops-mark.svg/route.ts";

test("brand mark is bundled in an HTTP route without relying on monorepo public copying", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/svg+xml");
  assert.match(response.headers.get("Cache-Control"), /public/);
  const svg = await response.text();
  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.match(svg, /#FFC938/);
  assert.match(svg, /<\/svg>$/);
});
