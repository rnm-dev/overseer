import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { LOCALES, useI18n } from "./i18n";

// UI primitives — styling lives in index.css (.warplate, .btn-*, .field, .badge-*).
// author: Viktor

type Variant = "fel" | "iron" | "ghost";

// Humanizes a slug-style key ("my-project_key" → "My Project Key") for display —
// project keys are stored as identifiers but read better title-cased.
export function titleize(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function Button({
  variant = "fel",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "md" | "sm" }) {
  return <button className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${className}`} {...props} />;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`field ${className}`} {...props} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`warplate ${className}`}>{children}</div>;
}

export function Dialog({ title, children, onClose, size = "md" }: { title: string; children: ReactNode; onClose: () => void; size?: "md" | "lg" }) {
  const { t } = useI18n();
  // Only dismiss when a press starts AND ends on the backdrop — so selecting text
  // inside and releasing outside (or vice-versa) never closes the modal.
  const downOnBackdrop = useRef(false);
  // Portaled to <body>: a page-level `.reveal` entrance animation leaves a
  // non-"none" computed transform behind after it finishes (animation-fill-mode:
  // both resolves to an identity matrix, not the literal keyword), which makes
  // `fixed` descendants resolve against that ancestor instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <Card className={`reveal w-full p-6 ${size === "lg" ? "max-w-2xl" : "max-w-md"}`}>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="rune fel-glow text-sm">{title}</h3>
          <button className="btn-ghost text-lg leading-none text-bone-faint hover:text-blood" onClick={onClose} aria-label={t("a11y.close")}>
            ✕
          </button>
        </div>
        <hr className="hairline mb-5" />
        {children}
      </Card>
    </div>,
    document.body,
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="block font-display text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-bone-dim">{children}</label>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "red" | "amber" }) {
  const map: Record<string, string> = { neutral: "badge-iron", green: "badge-fel", red: "badge-blood", amber: "badge-forge" };
  return <span className={`badge ${map[tone]}`}>{children}</span>;
}

export function StatusDot({ state }: { state: "on" | "off" | "busy" }) {
  return <span className={`statdot statdot--${state}`} aria-hidden />;
}

export function Logo({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src="/overseer-logo.png"
      alt="Overseer"
      className={`logo-glow ${className}`}
      style={{ height: size, width: "auto" }}
      draggable={false}
    />
  );
}

export function GithubMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function StatPlate({ value, label, tone = "fel" }: { value: ReactNode; label: string; tone?: "fel" | "forge" | "bone" }) {
  const color = tone === "fel" ? "text-fel-bright" : tone === "forge" ? "text-ember" : "text-bone";
  return (
    <Card className="px-4 py-3">
      <div className={`font-display text-2xl font-extrabold leading-none ${color}`}>{value}</div>
      <div className="mt-1.5 font-display text-[0.6rem] uppercase tracking-[0.16em] text-bone-dim">{label}</div>
    </Card>
  );
}

export function LocaleSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <div className={`inline-flex border border-iron-700 ${className}`}>
      {LOCALES.map((l) => (
        <button
          key={l.code}
          onClick={() => setLocale(l.code)}
          aria-pressed={locale === l.code}
          className={`px-2 py-1 font-display text-[0.62rem] font-bold uppercase tracking-[0.1em] transition-colors ${
            locale === l.code ? "bg-fel text-fel-ink" : "text-bone-dim hover:text-fel-bright"
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

// Full-width header for pages inside PeonDetail's right pane. Portaling keeps
// fixed positioning independent of the page reveal transform; the measured
// spacer preserves normal document flow when the header grows (menus aside,
// inline forms and error messages can make it taller).
export function FixedPaneHeader({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(49);

  useEffect(() => {
    if (!node) return;
    const measure = () => setHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--fixed-pane-header-height", `${height}px`);
    return () => { root.style.removeProperty("--fixed-pane-header-height"); };
  }, [height]);

  return (
    <>
      {createPortal(
        <div ref={setNode} className="fixed-pane-header fixed left-0 right-0 top-12 z-20 border-b border-iron-800 bg-void md:left-[var(--peon-sidebar-width)] md:top-0">
          {children}
        </div>,
        document.body,
      )}
      <div aria-hidden className="-mt-4 sm:-mt-7" style={{ height }} />
    </>
  );
}

// Slim page header shared by peon sub-pages: optional back link + h1 + inline
// meta (key/scope/badges), and a kebab menu for actions — so a page never
// grows a row of loose buttons. Sits flush under the peon nav tabs (the `-mt-4`
// cancels PeonDetail's nav `mb-4`, so the nav's bottom border stays visible with
// the header directly beneath it) and has symmetric top/bottom padding.
export function PageHeader({
  title,
  backTo,
  backLabel,
  meta,
  actions,
  menu,
  menuLabel,
}: {
  title: ReactNode;
  backTo?: string;
  backLabel?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  menu?: (close: () => void) => ReactNode;
  menuLabel?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <FixedPaneHeader>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {backTo && (
          <Link to={backTo} relative="path" className="flex-none font-mono text-xs text-bone-dim hover:text-fel-bright">
            {backLabel}
          </Link>
        )}
        <h1 className="truncate font-display text-sm font-semibold text-bone">{title}</h1>
        {meta}
      </div>
      {(actions || menu) && (
        <div className="flex flex-none items-center gap-2">
          {actions}
          {menu && <div className="relative" ref={menuRef}>
          <button
            type="button"
            title={menuLabel}
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center rounded p-1 text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="12" cy="5" r="1.75" />
              <circle cx="12" cy="12" r="1.75" />
              <circle cx="12" cy="19" r="1.75" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-iron-800 bg-iron-950 py-1 shadow-lg">
              {menu(() => setMenuOpen(false))}
            </div>
          )}
          </div>}
        </div>
      )}
    </div>
    </FixedPaneHeader>
  );
}

// Shared look for a row inside a PageHeader kebab menu — exported as a class
// string (not just a <MenuItem> button) so a navigation entry can use it on a
// <Link> too.
export function menuItemClass(tone: "default" | "danger" = "default"): string {
  return `block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors disabled:opacity-40 ${
    tone === "danger" ? "text-blood hover:bg-blood/10" : "text-bone-dim hover:bg-iron-900 hover:text-fel-bright"
  }`;
}

export function MenuItem({ tone = "default", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "danger" }) {
  return <button type="button" className={`${menuItemClass(tone)} ${className}`} {...props} />;
}

export function SectionHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="rune text-sm text-bone">{title}</h2>
      {right}
    </div>
  );
}
