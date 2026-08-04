import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEME_ID, THEME_CATALOG, renderThemeCss, validateThemeManifest } from "./index.js";

test("bundled theme manifests are ordered, bounded and CSS-renderable", () => {
  assert.equal(THEME_CATALOG[0]?.id, DEFAULT_THEME_ID);
  assert.deepEqual(THEME_CATALOG.map((theme) => theme.id), [
    "org.overseer.ironwood",
    "org.overseer.parchment",
    "org.overseer.sterling",
    "org.overseer.neon-nocturne",
    "org.overseer.amber-terminal",
    "org.overseer.candy-static",
  ]);
  const css = renderThemeCss();
  for (const theme of THEME_CATALOG) {
    assert.match(css, new RegExp(`data-overseer-theme="${theme.id.replaceAll(".", "\\.")}"`));
    assert.match(css, new RegExp(`--ov-canvas: ${theme.tokens["--ov-canvas"]}`));
  }
  assert.doesNotMatch(css, /url\s*\(|@import|expression\s*\(/i);
});

test("theme validation rejects executable or escaping CSS values", () => {
  const valid = THEME_CATALOG[0]!;
  assert.throws(() => validateThemeManifest({ ...valid, tokens: { ...valid.tokens, "--ov-canvas": "red; } body { display:none" } }), /unsafe/);
  assert.throws(() => validateThemeManifest({ ...valid, tokens: { ...valid.tokens, "--ov-logo": "url(https://attacker.example/x)" } }), /unsafe/);
  assert.throws(() => validateThemeManifest({ ...valid, tokens: { ...valid.tokens, "--evil": "red" } }), /name is invalid/);
});
