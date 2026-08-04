import { THEME_PACKAGE_FORMAT, validateThemePackage, type ThemePackageManifest } from "./themePackage";

export const DEFAULT_THEME_ID = "org.overseer.ironwood";
export const THEME_STORAGE_KEY = "overseer.theme-package";

export const DEFAULT_THEME: ThemePackageManifest = Object.freeze({
  format: THEME_PACKAGE_FORMAT,
  id: DEFAULT_THEME_ID,
  name: "Ironwood",
  version: "1.0.0",
  author: "Overseer",
  description: "Charcoal, aged bone, moss and restrained firelight.",
  appearance: "dark",
  capabilities: ["colors"],
  tokens: { "--ov-color-scheme": "dark" },
});

export interface ThemeCatalog {
  format: typeof THEME_PACKAGE_FORMAT;
  defaultThemeId: string;
  themes: readonly ThemePackageManifest[];
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolveTheme(id: string | null | undefined, themes: readonly ThemePackageManifest[]): ThemePackageManifest {
  return themes.find((theme) => theme.id === id) ?? themes.find((theme) => theme.id === DEFAULT_THEME_ID) ?? themes[0] ?? DEFAULT_THEME;
}

export function loadThemeId(storage?: ThemeStorage | null): string {
  try {
    return storage?.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
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
  applyTheme(DEFAULT_THEME);
  return DEFAULT_THEME;
}

export async function fetchThemeCatalog(signal?: AbortSignal): Promise<ThemeCatalog> {
  const response = await fetch("/api/v1/themes", { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`Theme catalog request failed (${response.status})`);
  const value = await response.json() as Partial<ThemeCatalog>;
  if (value.format !== THEME_PACKAGE_FORMAT || value.defaultThemeId !== DEFAULT_THEME_ID || !Array.isArray(value.themes)) {
    throw new Error("Theme catalog envelope is invalid");
  }
  const themes = value.themes.map(validateThemePackage);
  if (!themes.some((theme) => theme.id === DEFAULT_THEME_ID)) throw new Error("Theme catalog has no default theme");
  return { format: THEME_PACKAGE_FORMAT, defaultThemeId: DEFAULT_THEME_ID, themes };
}
