import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { type CatalogOption, type ModelProvider, type ModelsCatalog, providerForModel, effortsForModel, pickerEntries, pickerDisplayName } from "../fleet/modelsCatalog";
import { useT } from "../../shared/i18n";

// author: Viktor

interface PickerProps {
  options: CatalogOption[];
  value: string;
  onChange: (v: string) => void;
  // The text shown while nothing is selected and nothing is known to be
  // inherited — also the label of the reset entry in that case.
  defaultLabel?: string;
  // The option an empty value resolves to. It is marked "(Default)" in the
  // named list while reset/inherit remains a separate local action.
  defaultId?: string;
  label?: string;
  // Keep the accessible name while allowing forms to render a conventional
  // label above the trigger instead of repeating it inside the trigger.
  inlineLabel?: boolean;
  className?: string;
  // False for pickers that always have a concrete value (e.g. project) — no
  // "reset to default" entry, since there's nothing to fall back to.
  allowClear?: boolean;
}

export function Picker({ options, value, onChange, defaultLabel, defaultId, label, inlineLabel = true, className = "", allowClear = true }: PickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const entries = pickerEntries(options, value, {
    defaultId,
    defaultLabel,
    allowClear,
    markDefault: (name) => t("model.optionDefault", { name }),
  });
  const current = pickerDisplayName(options, value, { defaultId, defaultLabel });

  // The picker is used in a wrapping toolbar near the viewport edges. Portal
  // its menu and clamp it to the viewport instead of positioning it against a
  // trigger whose row can move or overflow on a narrow screen.
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = ref.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const gutter = 8;
      const gap = 6;
      const width = Math.min(Math.max(192, rect.width), window.innerWidth - gutter * 2);
      const left = Math.min(Math.max(gutter, rect.right - width), window.innerWidth - width - gutter);
      const roomAbove = rect.top - gap - gutter;
      const roomBelow = window.innerHeight - rect.bottom - gap - gutter;
      const placeAbove = roomAbove >= Math.min(288, roomBelow);
      const maxHeight = Math.max(96, Math.min(288, placeAbove ? roomAbove : roomBelow));
      setMenuStyle({
        left,
        width,
        maxHeight,
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={ref} className={`model-picker ${className}`}>
      <button type="button" className="model-picker-trigger" onClick={() => setOpen((o) => !o)} aria-label={label} aria-haspopup="listbox" aria-expanded={open}>
        <span className="truncate">
          {label && inlineLabel && <span className="model-picker-label">{label}{current ? ": " : ""}</span>}
          {current}
        </span>
        <svg className={`model-picker-chevron ${open ? "rotate-180" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={menuRef} className="model-picker-menu model-picker-menu--floating" style={menuStyle} role="listbox">
          {entries.map((entry) => (
            <button
              key={entry.value}
              type="button"
              className={`model-picker-option ${entry.active ? "is-active" : ""}`}
              onClick={() => choose(entry.value)}
              role="option"
              aria-selected={entry.active}
            >
              {entry.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

type CapabilityPickerProps = Omit<PickerProps, "options">;

export function AgentSelect({ catalog, allowClear = false, defaultId, ...props }: CapabilityPickerProps & { catalog: ModelsCatalog }) {
  // A session always lands on some agent, so the peon's own pick is the
  // default. Prefer the reported defaultAgent (settings.defaultAgent); older
  // peons that omit it fall back to the defaultModel/providers[0] heuristic.
  const defaultAgent = defaultId ?? catalog.defaultAgent ?? (providerForModel(catalog, catalog.defaultModel) ?? catalog.providers[0])?.agent;
  const options = catalog.providers.map((p) => ({ id: p.agent, label: p.label }));
  return <Picker {...props} options={options} defaultId={defaultAgent} allowClear={allowClear} />;
}

export function ModelSelect({ provider, allowClear = true, ...props }: CapabilityPickerProps & { provider: ModelProvider | null }) {
  const t = useT();
  if (provider?.catalogSource === "unavailable" && provider.models.length === 0) {
    return <span role="alert" className="font-mono text-xs text-danger">{t("model.catalogUnavailable")}: {provider.catalogError ?? t("error.loadFailed")}</span>;
  }
  return <Picker {...props} options={provider?.models ?? []} allowClear={allowClear} />;
}

// `model` scopes the options to what that model accepts on peons that advertise
// efforts per model; omit it to offer the provider's whole list.
export function ReasoningEffortSelect({ provider, model, ...props }: CapabilityPickerProps & { provider: ModelProvider | null; model?: string | null }) {
  return <Picker {...props} options={model !== undefined ? effortsForModel(provider, model) : provider?.reasoningEfforts ?? []} />;
}
