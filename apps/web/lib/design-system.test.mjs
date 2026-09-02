import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

function luminance(hex) {
  const [r, g, b] = hex.replace("#", "").match(/../g).map((value) => {
    const c = parseInt(value, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("shared small-text and action colors meet AA contrast", async () => {
  const css = await readFile(new URL("../app/tailwind.css", import.meta.url), "utf8");
  const token = (name) => css.match(new RegExp(`--${name}: (#[a-fA-F0-9]{6});`))[1];
  for (const [foreground, background] of [[token("ink"), token("canvas")], [token("muted"), token("canvas")], [token("muted"), "#ffffff"], ["#ffffff", token("brand")], ["#ffffff", "#d42a4d"]]) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background} needs 4.5:1 contrast`);
  }
});

test("web and native surfaces share the approved palette", async () => {
  const css = await readFile(new URL("../app/tailwind.css", import.meta.url), "utf8");
  const { theme: { extend: { colors } } } = createRequire(import.meta.url)("../../mobile/tailwind.config.js");
  for (const [web, native] of [["ink", "ink"], ["brand", "field"], ["canvas", "paper"], ["line", "line"], ["muted", "muted"]]) {
    const value = css.match(new RegExp(`--${web}: (#[a-fA-F0-9]{6});`))[1];
    assert.equal(value.toUpperCase(), colors[native]);
  }
});
