import { useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { LOCALES, useI18n } from "./i18n";

// UI primitives — styling lives in index.css (.warplate, .btn-*, .field, .badge-*).
// author: Viktor

type Variant = "fel" | "iron" | "ghost";

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

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  // Only dismiss when a press starts AND ends on the backdrop — so selecting text
  // inside and releasing outside (or vice-versa) never closes the modal.
  const downOnBackdrop = useRef(false);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
      onMouseDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <Card className="reveal w-full max-w-md p-6">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="rune fel-glow text-sm">{title}</h3>
          <button className="btn-ghost text-lg leading-none text-bone-faint hover:text-blood" onClick={onClose} aria-label={t("a11y.close")}>
            ✕
          </button>
        </div>
        <hr className="hairline mb-5" />
        {children}
      </Card>
    </div>
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

export function SectionHead({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="rune text-sm text-bone">{title}</h2>
      {right}
    </div>
  );
}
