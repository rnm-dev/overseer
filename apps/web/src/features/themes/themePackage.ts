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
  entrypoints: { web: string; flutter?: string };
  assets?: Record<string, string>;
  capabilities?: string[];
}

const PACKAGE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SAFE_PATH = /^(?![./])(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/;

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
  if (!manifest.entrypoints?.web || !SAFE_PATH.test(manifest.entrypoints.web)) throw new Error("Theme web entrypoint must be a relative package path");
  if (!manifest.entrypoints.web.endsWith(".css")) throw new Error("Theme web entrypoint must be CSS");
  if (manifest.entrypoints.flutter && !SAFE_PATH.test(manifest.entrypoints.flutter)) throw new Error("Theme Flutter entrypoint must be a relative package path");
  for (const path of Object.values(manifest.assets ?? {})) {
    if (!SAFE_PATH.test(path)) throw new Error(`Unsafe theme asset path: ${path}`);
  }
  return manifest as ThemePackageManifest;
}
