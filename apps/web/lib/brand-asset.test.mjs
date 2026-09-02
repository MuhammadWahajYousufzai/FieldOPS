import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const masterUrl = new URL("../../mobile/assets/brand/ribbon-heart-master.png", import.meta.url);

test("web header, favicon and native header all use the same named ribbon-heart master", async () => {
  for (const url of ["../app/brand-mark.tsx", "../app/layout.tsx", "../../mobile/app/index.tsx"]) {
    const source = await readFile(new URL(url, import.meta.url), "utf8");
    assert.match(source, /(?:import ribbonHeart from|const FIELDOPS_MARK = require\() ?["'][^"']*brand\/ribbon-heart-master\.png/);
    assert.doesNotMatch(source, /src="\/fieldops-mark\.svg"|icon: "\/fieldops-mark\.svg"/);
  }
  const png = await readFile(masterUrl);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
});

test("legacy SVG URL redirects to a bundled, content-hashed ribbon-heart asset", async () => {
  let importedAsset;
  const result = await build({
    entryPoints: [new URL("../app/fieldops-mark.svg/route.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "node", format: "esm",
    plugins: [{ name: "next-static-image", setup(builder) {
      builder.onLoad({ filter: /\.png$/ }, async ({ path }) => {
        const bytes = await readFile(path);
        assert.deepEqual(bytes, await readFile(masterUrl));
        importedAsset = `/_next/static/media/ribbon-heart-master.${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.png`;
        return { contents: `export default ${JSON.stringify({ src: importedAsset })}`, loader: "js" };
      });
    } }],
  });
  const { GET } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const response = GET();
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("Location"), importedAsset);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await response.text(), "");
});
