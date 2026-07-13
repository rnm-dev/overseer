import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { en } from "./locales/en";
import { ru } from "./locales/ru";

// Lightweight, dependency-free i18n. A locale is a flat key->string catalog;
// {var} placeholders are interpolated. Locale is persisted to localStorage and
// falls back to the browser language, then English. Add a language by dropping
// another catalog into `src/locales/` + wiring it into `catalogs` + `LOCALES`.
// author: Viktor

export type Locale = "en" | "ru";

type Catalog = Record<string, string>;

const catalogs: Record<Locale, Catalog> = { en, ru };

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "EN" },
  { code: "ru", label: "RU" },
];

const STORAGE_KEY = "overseer.locale";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ru") return saved;
  } catch {
    /* localStorage unavailable */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language?.slice(0, 2) : "en";
  return nav === "ru" ? "ru" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback<Translate>(
    (key, vars) => {
      const template = catalogs[locale][key] ?? catalogs.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export function useT(): Translate {
  return useI18n().t;
}
