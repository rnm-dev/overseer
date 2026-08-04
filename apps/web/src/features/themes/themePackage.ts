export const THEME_PACKAGE_FORMAT = "overseer-theme-v1" as const;

export type ThemeAppearance = "dark" | "light";

export interface ThemePackageManifest {
  format: typeof THEME_PACKAGE_FORMAT;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  appearance: ThemeAppearance;
  capabilities: string[];
  tokens: Record<string, string>;
}

const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const TOKEN_NAME = /^--(?:ov|font)-[a-z0-9-]+$/;
const UNSAFE_VALUE = /[;{}<>]|url\s*\(|@import|expression\s*\(/i;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 0x20);
}

export function validateThemePackage(value: unknown): ThemePackageManifest {
  if (!value || typeof value !== "object") throw new Error("Theme manifest must be an object");
  const manifest = value as Partial<ThemePackageManifest>;
  if (manifest.format !== THEME_PACKAGE_FORMAT) throw new Error(`Unsupported theme format: ${String(manifest.format)}`);
  if (!manifest.id || !PACKAGE_ID.test(manifest.id)) throw new Error("Theme id must be a reverse-domain identifier");
  if (!manifest.name?.trim()) throw new Error("Theme name is required");
  if (!manifest.author?.trim()) throw new Error("Theme author is required");
  if (!manifest.description?.trim()) throw new Error("Theme description is required");
  if (!manifest.version || !VERSION.test(manifest.version)) throw new Error("Theme version must use x.y.z");
  if (manifest.appearance !== "dark" && manifest.appearance !== "light") throw new Error("Theme appearance must be dark or light");
  if (!Array.isArray(manifest.capabilities)) throw new Error("Theme capabilities are required");
  if (!manifest.tokens || typeof manifest.tokens !== "object" || Array.isArray(manifest.tokens)) throw new Error("Theme tokens are required");
  const entries = Object.entries(manifest.tokens);
  if (!entries.length || entries.length > 96) throw new Error("Theme token count is invalid");
  for (const [name, value] of entries) {
    if (!TOKEN_NAME.test(name)) throw new Error(`Invalid theme token: ${name}`);
    if (typeof value !== "string" || value.length > 2048 || containsControlCharacter(value) || UNSAFE_VALUE.test(value)) throw new Error(`Unsafe theme token: ${name}`);
  }
  if (manifest.tokens["--ov-color-scheme"] !== manifest.appearance) throw new Error("Theme appearance token does not match manifest");
  return manifest as ThemePackageManifest;
}
