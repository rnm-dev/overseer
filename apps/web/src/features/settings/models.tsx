import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, isPeonNeedsUpdate } from "../../shared/api";
import { useT } from "../../shared/i18n";

// author: Viktor

export interface CatalogOption {
  id: string;
  label: string;
  alias?: string;
  // The peon marks its own pick within each provider's list (e.g. the model/
  // effort used when a session doesn't specify one) — this is the reliable
  // source of "default", not the top-level defaultModel (many peons omit it).
  default?: boolean;
  // Only on model options, and only on peons that scope efforts per model
  // rather than per provider. Present ⇒ authoritative for that model, including
  // an empty list meaning "this model takes no effort at all". Absent ⇒ fall
  // back to the provider-wide list. See effortsForModel.
  reasoningEfforts?: CatalogOption[];
}

export interface ModelProvider {
  agent: string;
  label: string;
  models: CatalogOption[];
  reasoningEfforts: CatalogOption[];
}

export interface ModelsCatalog {
  providers: ModelProvider[];
  defaultModel: string | null;
  // Which provider a session lands on when the create request omits `agent`
  // (peon's settings.defaultAgent). Older peons omit this field — callers fall
  // back to the same providers[0] heuristic as an omitted defaultModel.
  defaultAgent: string | null;
}

// Loads provider capabilities from Peon's /api/v1/models endpoint. A null
// catalog means "still loading"; unsupported older peons hide the controls.
export function useModels(base: string): { catalog: ModelsCatalog | null; supported: boolean } {
  const [catalog, setCatalog] = useState<ModelsCatalog | null>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setSupported(true);
    api<ModelsCatalog>(`${base}/models`)
      .then((c) => alive && setCatalog({
        providers: (c.providers ?? []).map((p) => ({
          ...p,
          models: p.models ?? [],
          reasoningEfforts: p.reasoningEfforts ?? [],
        })),
        defaultModel: c.defaultModel ?? null,
        defaultAgent: c.defaultAgent ?? null,
      }))
      .catch((err) => {
        if (alive && isPeonNeedsUpdate(err)) setSupported(false);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  return { catalog, supported };
}

export function providerForAgent(catalog: ModelsCatalog | null, agent: string | null | undefined): ModelProvider | null {
  return catalog?.providers.find((p) => p.agent === agent) ?? null;
}

export function providerForModel(catalog: ModelsCatalog | null, model: string | null | undefined): ModelProvider | null {
  if (!model) return null;
  return catalog?.providers.find((p) => p.models.some((m) => m.id === model || m.alias === model)) ?? null;
}

export function modelLabel(catalog: ModelsCatalog | null, id: string | null | undefined): string | null {
  if (!id) return null;
  for (const p of catalog?.providers ?? []) for (const m of p.models) if (m.id === id || m.alias === id) return m.label;
  return id;
}

// Effort ids are provider-scoped (unlike model ids), so resolving a label needs
// the provider the session runs on. An absent id means "the provider's own
// default", which is still a concrete effort worth naming in the UI.
export function reasoningEffortLabel(provider: ModelProvider | null, id: string | null | undefined): string | null {
  const effort = id
    ? provider?.reasoningEfforts.find((option) => optionMatches(option, id))
    : provider?.reasoningEfforts.find((option) => option.default);
  return effort?.label ?? id ?? null;
}

export function optionMatches(option: CatalogOption, value: string): boolean {
  return option.id === value || option.alias === value;
}

export function defaultModelId(provider: ModelProvider | null): string | undefined {
  return provider?.models.find((m) => m.default)?.id;
}

export function defaultReasoningEffortId(provider: ModelProvider | null): string | undefined {
  return provider?.reasoningEfforts.find((o) => o.default)?.id;
}

// Which efforts the given model actually accepts. A peon that advertises them
// per model wins; one that only advertises a provider-wide list keeps working
// unchanged. An empty result means the model takes no explicit effort and the
// selector must not offer one.
export function effortsForModel(provider: ModelProvider | null, model: string | null | undefined): CatalogOption[] {
  const selected = model ? provider?.models.find((m) => optionMatches(m, model)) : undefined;
  // No identified model (a session that never picked one) — the provider-wide
  // list is the only honest answer.
  if (!selected || !provider) return provider?.reasoningEfforts ?? [];
  if (selected.reasoningEfforts) return selected.reasoningEfforts;
  // A peon that scopes efforts per model omits the key entirely for a model
  // that takes none — Haiku ships as `{id, label, alias}` with no list — so
  // once any sibling model carries one, absence means "none" rather than
  // "unspecified". Only a peon that publishes no per-model lists at all still
  // falls back to the provider-wide catalog.
  return provider.models.some((m) => m.reasoningEfforts !== undefined) ? [] : provider.reasoningEfforts ?? [];
}

export function defaultEffortIdFor(options: CatalogOption[]): string | undefined {
  return options.find((option) => option.default)?.id;
}

// What a session with nothing pinned actually runs on: its own model if it has
// one, else the peon's pick for that provider. The top-level defaultModel is
// only usable when it belongs to this provider — a peon whose default sits in
// another agent says nothing about this one. Null ⇒ the peon named no default
// (both Codex providers today), and the reset entry stays an unadorned
// "Default" rather than a guess.
export function inheritedModelId(
  catalog: ModelsCatalog | null,
  provider: ModelProvider | null,
  sessionModel: string | null | undefined,
): string | null {
  if (sessionModel) return sessionModel;
  const own = defaultModelId(provider);
  if (own) return own;
  const global = catalog?.defaultModel ?? null;
  return global && provider?.models.some((model) => optionMatches(model, global)) ? global : null;
}

export interface PickerEntry {
  // The plain option name, which is what the closed trigger shows.
  name: string;
  // The menu text, which marks the inherited option as the default.
  label: string;
  // What onChange receives when this entry is picked.
  value: string;
  active: boolean;
}

// One entry per actual choice. The option an empty value falls back to is
// listed once and marked, rather than appearing both as a reset entry and again
// in the list — those were the same choice under two names.
export function pickerEntries(
  options: CatalogOption[],
  value: string,
  { defaultId, defaultLabel = "", allowClear, markDefault }: {
    defaultId?: string;
    defaultLabel?: string;
    allowClear: boolean;
    markDefault: (name: string) => string;
  },
): PickerEntry[] {
  const fallback = defaultId ? options.find((option) => optionMatches(option, defaultId)) : undefined;
  const selected = value ? options.find((option) => optionMatches(option, value)) : fallback;
  const entries = options.map((option) => ({
    name: option.label,
    label: option === fallback ? markDefault(option.label) : option.label,
    // Picking the inherited option means "nothing of my own" wherever that is
    // expressible, so the caller keeps following the peon instead of pinning
    // whatever the default happens to be today.
    value: option === fallback && allowClear ? "" : option.id,
    active: option === selected,
  }));
  // Only a picker whose fallback isn't among the options needs a reset row.
  if (allowClear && !fallback) entries.unshift({ name: defaultLabel, label: defaultLabel, value: "", active: !value });
  return entries;
}

interface PickerProps {
  options: CatalogOption[];
  value: string;
  onChange: (v: string) => void;
  // The text shown while nothing is selected and nothing is known to be
  // inherited — also the label of the reset entry in that case.
  defaultLabel?: string;
  // The option an empty value actually resolves to. It is listed once, marked
  // "(Default)" and shown as selected while the value is empty, instead of a
  // separate reset entry repeating it.
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
  const current = entries.find((entry) => entry.active)?.name ?? (value || defaultLabel);

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
          {label && inlineLabel && <span className="model-picker-label">{label}: </span>}
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
              key={entry.label}
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

export function AgentSelect({ catalog, allowClear: _allowClear, defaultId: _defaultId, ...props }: CapabilityPickerProps & { catalog: ModelsCatalog }) {
  // A session always lands on some agent, so the peon's own pick is the
  // default. Prefer the reported defaultAgent (settings.defaultAgent); older
  // peons that omit it fall back to the defaultModel/providers[0] heuristic.
  const defaultAgent = catalog.defaultAgent ?? (providerForModel(catalog, catalog.defaultModel) ?? catalog.providers[0])?.agent;
  const options = catalog.providers.map((p) => ({ id: p.agent, label: p.label }));
  return <Picker {...props} options={options} defaultId={defaultAgent} allowClear={false} />;
}

export function ModelSelect({ provider, ...props }: CapabilityPickerProps & { provider: ModelProvider | null }) {
  return <Picker {...props} options={provider?.models ?? []} />;
}

// `model` scopes the options to what that model accepts on peons that advertise
// efforts per model; omit it to offer the provider's whole list.
export function ReasoningEffortSelect({ provider, model, ...props }: CapabilityPickerProps & { provider: ModelProvider | null; model?: string | null }) {
  return <Picker {...props} options={model !== undefined ? effortsForModel(provider, model) : provider?.reasoningEfforts ?? []} />;
}
