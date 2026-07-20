import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type InputHTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";
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

export function Dialog({ title, children, onClose, size = "md", dismissible = true }: { title: ReactNode; children: ReactNode; onClose: () => void; size?: "md" | "lg"; dismissible?: boolean }) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const dragRef = useRef<{ pointerId: number; startY: number; lastY: number; lastAt: number; velocity: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  closeRef.current = onClose;
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = panel?.querySelector<HTMLElement>("[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
      (target ?? panel)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissibleRef.current) closeRef.current();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) { event.preventDefault(); panelRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dismissible || !window.matchMedia("(max-width: 767px)").matches) return;
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastAt: performance.now(), velocity: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = performance.now();
    drag.velocity = (event.clientY - drag.lastY) / Math.max(1, now - drag.lastAt);
    drag.lastY = event.clientY;
    drag.lastAt = now;
    setDragY(Math.max(0, event.clientY - drag.startY));
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    const velocity = performance.now() - drag.lastAt < 80 ? drag.velocity : 0;
    dragRef.current = null;
    setDragging(false);
    if (distance > 96 || (distance > 28 && velocity > 0.55)) closeRef.current();
    else setDragY(0);
  }
  // Only dismiss when a press starts AND ends on the backdrop — so selecting text
  // inside and releasing outside (or vice-versa) never closes the modal.
  const downOnBackdrop = useRef(false);
  // Portaled to <body>: a page-level `.reveal` entrance animation leaves a
  // non-"none" computed transform behind after it finishes (animation-fill-mode:
  // both resolves to an identity matrix, not the literal keyword), which makes
  // `fixed` descendants resolve against that ancestor instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid items-end bg-[radial-gradient(circle_at_50%_18%,rgba(149,201,103,0.08),transparent_38%),rgba(2,4,3,0.82)] backdrop-blur-md md:place-items-center md:p-5"
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (dismissible && e.target === e.currentTarget && downOnBackdrop.current) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative w-full max-h-[calc(100dvh-0.75rem)] overflow-hidden overflow-y-auto rounded-b-none rounded-t-2xl border border-iron-700/80 bg-iron-900/95 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[0_28px_90px_rgba(0,0,0,0.65),0_0_0_1px_rgba(149,201,103,0.04)] md:max-h-[calc(100vh-2.5rem)] md:rounded-xl md:p-6 md:pb-6 ${size === "lg" ? "md:max-w-2xl" : "md:max-w-md"}`}
        style={{ transform: `translateY(${dragY}px)`, transition: dragging ? "none" : "transform 180ms ease" }}
      >
        <div
          aria-hidden="true"
          className="-mx-5 -mt-5 mb-1 flex h-9 touch-none cursor-grab items-center justify-center md:hidden"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="h-1 w-10 rounded-full bg-iron-600/90" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-fel/45 to-transparent" />
        <div className="mb-4 flex items-start gap-3 border-b border-iron-800/90 pb-4">
          <h3 id={titleId} className="min-w-0 flex-1 font-display text-base font-bold tracking-wide text-bone">{title}</h3>
          <button className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-transparent text-base leading-none text-bone-faint transition-colors hover:border-iron-700 hover:bg-iron-800 hover:text-bone" onClick={onClose} disabled={!dismissible} aria-label={t("a11y.close")}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmationDialog({ title, description, confirmLabel, pendingLabel, onConfirm, onClose, pending = false, destructive = true }: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  destructive?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={title} onClose={onClose} dismissible={!pending}>
      {description && <div className="mb-5 text-sm leading-relaxed text-bone-dim">{description}</div>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="iron" onClick={onClose} disabled={pending}>{t("action.cancel")}</Button>
        <Button
          autoFocus
          className={destructive ? "!border-blood/50 !text-blood hover:!bg-blood/10" : ""}
          variant={destructive ? "iron" : "fel"}
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? pendingLabel ?? confirmLabel : confirmLabel}
        </Button>
      </div>
    </Dialog>
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
  return (
    <FixedPaneHeader>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        {backTo && (
          <Link to={backTo} relative="path" className="flex-none font-body text-xs text-bone-dim hover:text-fel-bright">
            {backLabel}
          </Link>
        )}
        <h1 className="truncate font-display text-sm font-semibold text-bone">{title}</h1>
        {meta}
      </div>
      {(actions || menu) && (
        <div className="flex flex-none items-center gap-2">
          {actions}
          {menu && (
            <DropdownMenu
              label={menuLabel}
              buttonClassName="flex items-center rounded p-1 text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone"
              trigger={(
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="12" cy="5" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="12" cy="19" r="1.75" />
                </svg>
              )}
            >
              {menu}
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
    </FixedPaneHeader>
  );
}

export function DropdownMenu({
  label,
  trigger,
  children,
  className = "",
  buttonClassName = "",
  menuAlignClassName = "right-0",
  menuWidthClassName = "w-44",
}: {
  label?: string;
  trigger: ReactNode | ((open: boolean) => ReactNode);
  children: (close: () => void) => ReactNode;
  className?: string;
  buttonClassName?: string;
  menuAlignClassName?: string;
  menuWidthClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={buttonClassName}
        onClick={() => setOpen((value) => !value)}
      >
        {typeof trigger === "function" ? trigger(open) : trigger}
      </button>
      {open && (
        <div role="menu" className={`absolute top-full z-30 mt-1 overflow-hidden rounded-lg border border-iron-800 bg-iron-950 py-1 shadow-lg ${menuAlignClassName} ${menuWidthClassName}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// Shared look for a row inside a PageHeader kebab menu — exported as a class
// string (not just a <MenuItem> button) so a navigation entry can use it on a
// <Link> too.
export function menuItemClass(tone: "default" | "danger" = "default"): string {
  return `block w-full px-3 py-1.5 text-left font-body text-xs transition-colors disabled:opacity-40 ${
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
