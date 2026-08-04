import amberTerminalSource from "./manifests/amber-terminal.json" with { type: "json" };
import candyStaticSource from "./manifests/candy-static.json" with { type: "json" };
import ironwoodSource from "./manifests/ironwood.json" with { type: "json" };
import neonNocturneSource from "./manifests/neon-nocturne.json" with { type: "json" };
import parchmentSource from "./manifests/parchment.json" with { type: "json" };
import sterlingSource from "./manifests/sterling.json" with { type: "json" };

export const THEME_PACKAGE_FORMAT = "overseer-theme-v1" as const;
export const DEFAULT_THEME_ID = "org.overseer.ironwood";

export interface ThemeManifest {
  format: typeof THEME_PACKAGE_FORMAT;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  appearance: "dark" | "light";
  capabilities: string[];
  tokens: Record<string, string>;
}

const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const TOKEN_NAME = /^--(?:ov|font)-[a-z0-9-]+$/;
const UNSAFE_CSS_VALUE = /[;{}<>]|url\s*\(|@import|expression\s*\(/i;
const MAX_TOKENS = 96;
const MAX_TOKEN_VALUE = 2_048;

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 0x20);
}

export function validateThemeManifest(value: unknown): ThemeManifest {
  if (!value || typeof value !== "object") throw new Error("theme manifest must be an object");
  const manifest = value as Partial<ThemeManifest>;
  if (manifest.format !== THEME_PACKAGE_FORMAT) throw new Error(`unsupported theme format: ${String(manifest.format)}`);
  if (!manifest.id || !PACKAGE_ID.test(manifest.id)) throw new Error("theme id must be a reverse-domain identifier");
  if (!manifest.name?.trim() || manifest.name.length > 80) throw new Error("theme name is invalid");
  if (!manifest.version || !VERSION.test(manifest.version)) throw new Error("theme version must use x.y.z");
  if (!manifest.author?.trim() || !manifest.description?.trim()) throw new Error("theme metadata is incomplete");
  if (manifest.appearance !== "dark" && manifest.appearance !== "light") throw new Error("theme appearance is invalid");
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((item) => typeof item !== "string" || item.length > 40)) {
    throw new Error("theme capabilities are invalid");
  }
  if (!manifest.tokens || typeof manifest.tokens !== "object" || Array.isArray(manifest.tokens)) throw new Error("theme tokens are required");
  const entries = Object.entries(manifest.tokens);
  if (entries.length === 0 || entries.length > MAX_TOKENS) throw new Error("theme token count is invalid");
  for (const [name, raw] of entries) {
    if (!TOKEN_NAME.test(name)) throw new Error(`theme token name is invalid: ${name}`);
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_TOKEN_VALUE || containsControlCharacter(raw) || UNSAFE_CSS_VALUE.test(raw)) {
      throw new Error(`theme token value is unsafe: ${name}`);
    }
  }
  if (manifest.tokens["--ov-color-scheme"] !== manifest.appearance) throw new Error("theme appearance token does not match manifest");
  return manifest as ThemeManifest;
}

export const THEME_CATALOG: readonly ThemeManifest[] = Object.freeze([
  validateThemeManifest(ironwoodSource),
  validateThemeManifest(parchmentSource),
  validateThemeManifest(sterlingSource),
  validateThemeManifest(neonNocturneSource),
  validateThemeManifest(amberTerminalSource),
  validateThemeManifest(candyStaticSource),
]);

export function renderThemeCss(catalog: readonly ThemeManifest[] = THEME_CATALOG): string {
  return `${catalog.map((theme, index) => {
    const selector = index === 0
      ? `:root,\n:root[data-overseer-theme="${theme.id}"]`
      : `:root[data-overseer-theme="${theme.id}"]`;
    const declarations = Object.entries(theme.tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n");
    return `${selector} {\n${declarations}\n}`;
  }).join("\n\n")}\n`;
}
