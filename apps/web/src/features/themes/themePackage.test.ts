import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME,
  DEFAULT_THEME_ID,
  fetchThemeCatalog,
  loadThemeId,
  resolveTheme,
  saveTheme,
  THEME_STORAGE_KEY,
} from "./themeRegistry";
import { validateThemePackage, type ThemePackageManifest } from "./themePackage";

const parchment: ThemePackageManifest = {
  ...DEFAULT_THEME,
  id: "org.overseer.parchment",
  name: "Parchment",
  appearance: "light",
  tokens: { "--ov-color-scheme": "light", "--ov-canvas": "#f3efe4" },
};

test("server theme manifests satisfy the versioned token contract", () => {
  assert.equal(validateThemePackage(DEFAULT_THEME).id, DEFAULT_THEME_ID);
  assert.equal(validateThemePackage(parchment).appearance, "light");
});

test("unknown and unavailable themes fall back to Ironwood", () => {
  assert.equal(resolveTheme("org.example.missing", [DEFAULT_THEME, parchment]).id, DEFAULT_THEME_ID);
  assert.equal(loadThemeId({ getItem: () => "org.example.missing", setItem() {} }), "org.example.missing");
  assert.equal(loadThemeId({ getItem: () => { throw new Error("blocked"); }, setItem() {} }), DEFAULT_THEME_ID);
});

test("theme selection persists only the package id", () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) };
  saveTheme(parchment, storage);
  assert.equal(stored.get(THEME_STORAGE_KEY), "org.overseer.parchment");
});

test("theme manifests reject executable CSS tokens", () => {
  assert.throws(() => validateThemePackage({ ...parchment, tokens: { ...parchment.tokens, "--ov-logo": "url(https://evil.example/x)" } }), /Unsafe/);
  assert.throws(() => validateThemePackage({ ...parchment, tokens: { ...parchment.tokens, "--evil": "red" } }), /Invalid/);
});

test("theme catalog is loaded from the server and validated", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    format: "overseer-theme-v1",
    defaultThemeId: DEFAULT_THEME_ID,
    themes: [DEFAULT_THEME, parchment],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const catalog = await fetchThemeCatalog();
  assert.deepEqual(catalog.themes.map((theme) => theme.id), [DEFAULT_THEME_ID, parchment.id]);
});
