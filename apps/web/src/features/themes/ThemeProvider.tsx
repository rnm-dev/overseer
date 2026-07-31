import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { applyTheme, BUNDLED_THEMES, initializeTheme, resolveTheme, saveTheme } from "./themeRegistry";
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
  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    themes: BUNDLED_THEMES,
    selectTheme(id) {
      const next = resolveTheme(id);
      applyTheme(next);
      saveTheme(next, localStorage);
      setTheme(next);
    },
  }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
