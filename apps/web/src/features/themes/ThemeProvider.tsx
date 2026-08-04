import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyTheme, DEFAULT_THEME, fetchThemeCatalog, initializeTheme, loadThemeId, resolveTheme, saveTheme } from "./themeRegistry";
import type { ThemePackageManifest } from "./themePackage";

interface ThemeContextValue {
  theme: ThemePackageManifest;
  themes: readonly ThemePackageManifest[];
  selectTheme: (id: string) => void;
}

const initialTheme = initializeTheme();
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(initialTheme);
  const [themes, setThemes] = useState<readonly ThemePackageManifest[]>([DEFAULT_THEME]);
  useEffect(() => {
    const controller = new AbortController();
    void fetchThemeCatalog(controller.signal).then((catalog) => {
      const next = resolveTheme(loadThemeId(localStorage), catalog.themes);
      setThemes(catalog.themes);
      setTheme(next);
      applyTheme(next);
    }).catch(() => {
      // The CSS and default manifest remain usable if catalog discovery fails.
    });
    return () => controller.abort();
  }, []);
  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    themes,
    selectTheme(id) {
      const next = resolveTheme(id, themes);
      applyTheme(next);
      saveTheme(next, localStorage);
      setTheme(next);
    },
  }), [theme, themes]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
