import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, List, PanelsTopLeft } from "lucide-react";
import { useT } from "../i18n";
import { SIDEBAR_SECTION_ACTION_CLASS, SidebarSectionHeader } from "./SidebarSectionHeader";

export type SessionListDisplayMode = "grouped" | "flat";

export const SESSION_LIST_MODE_STORAGE_KEY = "overseer:session-list:display-mode";
export const SESSION_LIST_LIMIT_STORAGE_KEY = "overseer:session-list:project-limit";
export const SESSION_LIST_LIMIT_OPTIONS = [3, 5, 10] as const;

export function loadSessionListDisplayMode(storage?: Pick<Storage, "getItem">): SessionListDisplayMode {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    return target?.getItem(SESSION_LIST_MODE_STORAGE_KEY) === "flat" ? "flat" : "grouped";
  } catch {
    return "grouped";
  }
}

export function saveSessionListDisplayMode(mode: SessionListDisplayMode, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(SESSION_LIST_MODE_STORAGE_KEY, mode);
  } catch {
    // A preference must not make the session list unusable when storage is blocked.
  }
}

export function loadSessionListProjectLimit(storage?: Pick<Storage, "getItem">): number {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const value = Number(target?.getItem(SESSION_LIST_LIMIT_STORAGE_KEY));
    return SESSION_LIST_LIMIT_OPTIONS.includes(value as (typeof SESSION_LIST_LIMIT_OPTIONS)[number]) ? value : 5;
  } catch {
    return 5;
  }
}

export function saveSessionListProjectLimit(limit: number, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(SESSION_LIST_LIMIT_STORAGE_KEY, String(limit));
  } catch {
    // See saveSessionListDisplayMode.
  }
}

export function displayMenuPosition(anchor: DOMRect, viewportWidth: number, viewportHeight: number) {
  const width = 240;
  const height = 250;
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(anchor.right - width, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(anchor.bottom + 6, viewportHeight - height - margin)),
  };
}

export function SessionListDisplayControl({
  mode,
  projectLimit,
  onModeChange,
  onProjectLimitChange,
}: {
  mode: SessionListDisplayMode;
  projectLimit: number;
  onModeChange: (mode: SessionListDisplayMode) => void;
  onProjectLimitChange: (limit: number) => void;
}) {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [position, setPosition] = useState({ x: 8, y: 8 });

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOutside = (event: MouseEvent) => {
      if (!mobile && !panelRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnViewportChange = () => {
      if (mobile) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button")?.focus());
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      previousFocus?.focus();
    };
  }, [mobile, open]);

  const openMenu = () => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (anchor) setPosition(displayMenuPosition(anchor, window.innerWidth, window.innerHeight));
    setOpen(true);
  };

  const modeOptions: Array<{ value: SessionListDisplayMode; label: string; icon: typeof List }> = [
    { value: "grouped", label: t("sessions.display.grouped"), icon: PanelsTopLeft },
    { value: "flat", label: t("sessions.display.flat"), icon: List },
  ];

  const panel = open ? (
    <>
      {mobile && <button type="button" className="fixed inset-0 z-[109] bg-black/55" aria-label={t("a11y.close")} onClick={() => setOpen(false)} />}
      <div
        ref={panelRef}
        role={mobile ? "dialog" : "menu"}
        aria-modal={mobile || undefined}
        aria-label={t("sessions.display.title")}
        className={mobile
          ? "fixed inset-x-0 bottom-0 z-[110] rounded-t-2xl border-t border-edge-strong bg-surface-raised px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl"
          : "fixed z-[110] w-60 overflow-hidden rounded-xl border border-edge-strong bg-surface-raised p-2 shadow-2xl"}
        style={mobile ? undefined : { left: position.x, top: position.y }}
      >
        {mobile && <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-surface-disabled" />}
        <div className="px-2 pb-2 pt-1 font-display text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-ink-faint">
          {t("sessions.display.mode")}
        </div>
        <div className="space-y-1">
          {modeOptions.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role={mobile ? undefined : "menuitemradio"}
              aria-checked={mobile ? undefined : mode === value}
              className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left font-body text-xs transition-colors ${mode === value ? "bg-accent/10 text-ink" : "text-ink-muted hover:bg-surface-hover hover:text-ink"}`}
              onClick={() => onModeChange(value)}
            >
              <Icon size={15} aria-hidden />
              <span className="min-w-0 flex-1">{label}</span>
              {mode === value && <Check size={14} className="text-accent-strong" aria-hidden />}
            </button>
          ))}
        </div>
        {mode === "grouped" && (
          <div className="mt-2 border-t border-edge pt-2">
            <div className="px-2 pb-2 font-display text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-ink-faint">
              {t("sessions.display.limit")}
            </div>
            <div className="grid grid-cols-3 gap-1 px-1">
              {SESSION_LIST_LIMIT_OPTIONS.map((limit) => (
                <button
                  key={limit}
                  type="button"
                  role={mobile ? undefined : "menuitemradio"}
                  aria-checked={mobile ? undefined : projectLimit === limit}
                  className={`min-h-9 rounded-lg font-mono text-xs transition-colors ${projectLimit === limit ? "bg-accent/15 text-accent-strong" : "bg-ink/5 text-ink-muted hover:bg-surface-hover hover:text-ink"}`}
                  onClick={() => onProjectLimitChange(limit)}
                >
                  {limit}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  ) : null;

  return (
    <>
      <div>
        <SidebarSectionHeader
          label={t("sessions.display.title")}
          action={(
            <button
              ref={triggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              className={SIDEBAR_SECTION_ACTION_CLASS}
              onClick={() => open ? setOpen(false) : openMenu()}
            >
              {mode === "grouped" ? t("sessions.display.grouped") : t("sessions.display.flat")}
            </button>
          )}
        />
      </div>
      {open && createPortal(panel, document.body)}
    </>
  );
}
