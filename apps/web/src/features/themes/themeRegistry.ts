import ironwoodSource from "./packages/ironwood/theme.json";
import parchmentSource from "./packages/parchment/theme.json";
import sterlingSource from "./packages/sterling/theme.json";
import neonNocturneSource from "./packages/neon-nocturne/theme.json";
import amberTerminalSource from "./packages/amber-terminal/theme.json";
import candyStaticSource from "./packages/candy-static/theme.json";
import { validateThemePackage, type ThemePackageManifest } from "./themePackage";

export const DEFAULT_THEME_ID = "org.overseer.ironwood";
export const THEME_STORAGE_KEY = "overseer.theme-package";

export const BUNDLED_THEMES: readonly ThemePackageManifest[] = Object.freeze([
  validateThemePackage(ironwoodSource),
  validateThemePackage(parchmentSource),
  validateThemePackage(sterlingSource),
  validateThemePackage(neonNocturneSource),
  validateThemePackage(amberTerminalSource),
  validateThemePackage(candyStaticSource),
]);

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolveTheme(id: string | null | undefined): ThemePackageManifest {
  return BUNDLED_THEMES.find((theme) => theme.id === id) ?? BUNDLED_THEMES[0];
}

export function loadTheme(storage?: ThemeStorage | null): ThemePackageManifest {
  if (!storage) return resolveTheme(null);
  try {
    return resolveTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return resolveTheme(null);
  }
}

export function saveTheme(theme: ThemePackageManifest, storage?: ThemeStorage | null): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme.id);
  } catch {
    // A blocked storage API must never prevent the safe bundled fallback.
  }
}

export function applyTheme(theme: ThemePackageManifest, root?: HTMLElement): void {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!target) return;
  target.dataset.overseerTheme = theme.id;
  target.dataset.themeAppearance = theme.appearance;
  target.style.colorScheme = theme.appearance;
}

export function initializeTheme(): ThemePackageManifest {
  const theme = loadTheme(typeof localStorage === "undefined" ? null : localStorage);
  applyTheme(theme);
  return theme;
}
