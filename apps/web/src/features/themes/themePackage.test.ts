import assert from "node:assert/strict";
import test from "node:test";
import ironwood from "./packages/ironwood/theme.json" with { type: "json" };
import { BUNDLED_THEMES, DEFAULT_THEME_ID, loadTheme, resolveTheme, saveTheme, THEME_STORAGE_KEY } from "./themeRegistry";
import { validateThemePackage } from "./themePackage";

test("bundled theme packages satisfy the versioned contract", () => {
  assert.equal(validateThemePackage(ironwood).id, DEFAULT_THEME_ID);
  assert.deepEqual(BUNDLED_THEMES.map((theme) => theme.id), ["org.overseer.ironwood", "org.overseer.parchment", "org.overseer.sterling", "org.overseer.neon-nocturne", "org.overseer.amber-terminal", "org.overseer.candy-static"]);
});

test("unknown and unavailable themes fall back to Ironwood", () => {
  assert.equal(resolveTheme("org.example.missing").id, DEFAULT_THEME_ID);
  assert.equal(loadTheme({ getItem: () => "org.example.missing", setItem() {} }).id, DEFAULT_THEME_ID);
  assert.equal(loadTheme({ getItem: () => { throw new Error("blocked"); }, setItem() {} }).id, DEFAULT_THEME_ID);
});

test("theme selection persists only the package id", () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) };
  saveTheme(BUNDLED_THEMES[1], storage);
  assert.equal(stored.get(THEME_STORAGE_KEY), "org.overseer.parchment");
  assert.equal(loadTheme(storage).appearance, "light");
});

test("theme manifests reject executable and escaping entrypoints", () => {
  assert.throws(() => validateThemePackage({ ...ironwood, entrypoints: { web: "../evil.css" } }), /relative package path/);
  assert.throws(() => validateThemePackage({ ...ironwood, entrypoints: { web: "theme.js" } }), /relative package path|web entrypoint/);
});
