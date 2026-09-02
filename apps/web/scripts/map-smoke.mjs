import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GET as logo } from "../app/fieldops-mark.svg/route.ts";

// Run after pnpm build: node --experimental-strip-types scripts/map-smoke.mjs
// Open the printed URL in a browser and exercise all three production maps.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({ absWorkingDir: root, entryPoints: ["tests/map-smoke.tsx"], bundle: true, write: false, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
const cssDir = path.join(root, ".next/static/chunks");
const css = (await Promise.all((await readdir(cssDir)).filter((name) => name.endsWith(".css")).map((name) => readFile(path.join(cssDir, name), "utf8")))).join("\n");
const svg = await logo().text();
createServer((request, response) => {
  const routes = {
    "/": ["text/html", '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><title>FieldOPS map regression check</title></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'],
    "/app.css": ["text/css", css],
    "/fixture.js": ["text/javascript", bundle.outputFiles[0].contents],
    "/fieldops-mark.svg": ["image/svg+xml", svg],
  };
  const match = routes[request.url];
  if (!match) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": match[0] }).end(match[1]);
}).listen(3091, "127.0.0.1", () => console.log("Map smoke check: http://127.0.0.1:3091"));
