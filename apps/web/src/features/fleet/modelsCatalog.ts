import { useEffect, useRef, useState } from "react";
import { api, isPeonNeedsUpdate } from "../../shared/api";

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
  capabilities?: { login?: boolean; logout?: boolean };
  agent: string;
  label: string;
  models: CatalogOption[];
  reasoningEfforts: CatalogOption[];
  catalogSource?: "cli" | "stale-cli" | "unavailable";
  catalogError?: string | null;
}

export interface ModelsCatalog {
  providers: ModelProvider[];
  defaultModel: string | null;
  // Which provider a session lands on when the create request omits `agent`
  // (peon's settings.defaultAgent). Older peons omit this field — callers fall
  // back to the same providers[0] heuristic as an omitted defaultModel.
  defaultAgent: string | null;
}

function normalizeCatalog(catalog: ModelsCatalog): ModelsCatalog {
  return {
    providers: (catalog.providers ?? []).map((provider) => ({
      ...provider,
      models: provider.models ?? [],
      reasoningEfforts: provider.reasoningEfforts ?? [],
    })),
    defaultModel: catalog.defaultModel ?? null,
    defaultAgent: catalog.defaultAgent ?? null,
  };
}

// Loads provider capabilities from Peon's /api/v1/models endpoint. A null
// catalog means "still loading"; unsupported older peons hide the controls.
export function useModels(base: string): { catalog: ModelsCatalog | null; supported: boolean } {
  const [catalog, setCatalog] = useState<ModelsCatalog | null>(null);
  const [supported, setSupported] = useState(true);
  const latestCatalogRef = useRef<ModelsCatalog | null>(null);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let retry: number | null = null;
    let retryCount = 0;
    const maxRetries = 3;
    latestCatalogRef.current = null;
    setCatalog(null);
    setSupported(true);

    const load = (refresh: boolean) => {
      if (inFlight) return;
      inFlight = true;
      api<ModelsCatalog>(`${base}/models${refresh ? "?refresh=1" : ""}`)
        .then((next) => {
          if (!alive) return;
          const normalized = normalizeCatalog(next);
          latestCatalogRef.current = normalized;
          setCatalog(normalized);
          setSupported(true);
          retryCount = 0;
        })
        .catch((error) => {
          if (!alive) return;
          // A refresh failure must not erase a catalog that was good a moment
          // ago. A fresh 404 still identifies an older Peon so its controls
          // stay hidden until the foreground/retry read succeeds after update.
          if (isPeonNeedsUpdate(error) && !latestCatalogRef.current) setSupported(false);
          if (retryCount < maxRetries && retry === null) {
            retryCount += 1;
            retry = window.setTimeout(() => {
              retry = null;
              load(true);
            }, 30_000);
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const recover = () => {
      if (document.visibilityState === "visible") load(true);
    };
    load(false);
    document.addEventListener("visibilitychange", recover);
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    return () => {
      alive = false;
      if (retry !== null) window.clearTimeout(retry);
      document.removeEventListener("visibilitychange", recover);
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
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

// A reported default agent is authoritative even when the newly refreshed
// catalog no longer contains it. Falling through to providers[0] in that case
// would silently put an existing session on another provider.
export function defaultProviderForCatalog(catalog: ModelsCatalog | null): ModelProvider | null {
  if (!catalog) return null;
  if (catalog.defaultAgent) return providerForAgent(catalog, catalog.defaultAgent);
  return providerForModel(catalog, catalog.defaultModel) ?? catalog.providers[0] ?? null;
}

export function providerForSession(
  catalog: ModelsCatalog | null,
  agent: string | null | undefined,
  model: string | null | undefined,
): ModelProvider | null {
  if (agent) return providerForAgent(catalog, agent);
  if (model) return providerForModel(catalog, model);
  return defaultProviderForCatalog(catalog);
}

export function modelLabel(catalog: ModelsCatalog | null, id: string | null | undefined): string | null {
  if (!id) return null;
  for (const p of catalog?.providers ?? []) for (const m of p.models) if (m.id === id || m.alias === id) return m.label;
  return id;
}

// Effort ids are provider-scoped (unlike model ids), so resolving a label needs
// the provider the session runs on. An absent id means "the provider's own
// default", which is still a concrete effort worth naming in the UI.
export function reasoningEffortLabel(provider: ModelProvider | null, id: string | null | undefined, model?: string | null): string | null {
  const effort = id
    ? reasoningEffortsForEffectiveModel(provider, model ?? null).find((option) => optionMatches(option, id))
    : reasoningEffortsForEffectiveModel(provider, model ?? null).find((option) => option.default);
  return effort?.label ?? id ?? null;
}

export function optionMatches(option: CatalogOption, value: string): boolean {
  return option.id === value || option.alias === value;
}

export function defaultModelId(provider: ModelProvider | null): string | undefined {
  return provider?.models.find((m) => m.default)?.id;
}

export function defaultReasoningEffortId(provider: ModelProvider | null, model?: string | null): string | undefined {
  return reasoningEffortsForEffectiveModel(provider, model ?? null).find((o) => o.default)?.id;
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

// Composer policy: choose a supported concrete value when the CLI publishes no default.
// Callers persist this choice in the draft so requests send exactly what is shown.
export function composerDefaultEffortId(options: CatalogOption[]): string | undefined {
  return defaultEffortIdFor(options) ?? options.find((option) => option.id === "medium")?.id ?? options[0]?.id;
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

// The effective model is the only authority for effort choices. Keep it in one
// place so a model switch cannot leave an effort picker offering (or a request
// sending) a value that belongs to a different model.
export function effectiveModelId(
  catalog: ModelsCatalog | null,
  provider: ModelProvider | null,
  overrideModel: string | null | undefined,
  sessionModel: string | null | undefined,
): string | null {
  return overrideModel || inheritedModelId(catalog, provider, sessionModel);
}

export function reasoningEffortsForEffectiveModel(
  provider: ModelProvider | null,
  model: string | null | undefined,
): CatalogOption[] {
  // A known but no-longer-advertised model must not inherit a provider-wide
  // effort union. The caller can still name the raw model identity, but cannot
  // accidentally submit an effort Peon will reject for it.
  if (model && !provider?.models.some((option) => optionMatches(option, model))) return [];
  return effortsForModel(provider, model);
}

export function isReasoningEffortValid(
  provider: ModelProvider | null,
  model: string | null | undefined,
  effort: string | null | undefined,
): boolean {
  return Boolean(effort) && reasoningEffortsForEffectiveModel(provider, model).some((option) => optionMatches(option, effort!));
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

// Named rows always produce their concrete id. Reset/inherit is deliberately a
// separate row: it clears only the local draft and never pretends to unpin a
// session already accepted by Peon.
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
  const selected = value ? options.find((option) => optionMatches(option, value)) : allowClear ? undefined : fallback;
  const entries = options.map((option) => ({
    name: option.label,
    label: option === fallback ? markDefault(option.label) : option.label,
    value: option.id,
    active: option === selected,
  }));
  if (allowClear) entries.unshift({ name: defaultLabel, label: defaultLabel, value: "", active: !value });
  return entries;
}

export function pickerDisplayName(
  options: CatalogOption[],
  value: string,
  { defaultId, defaultLabel = "" }: { defaultId?: string; defaultLabel?: string },
): string {
  if (value) return options.find((option) => optionMatches(option, value))?.label ?? value;
  return defaultId
    ? options.find((option) => optionMatches(option, defaultId))?.label ?? defaultId
    : defaultLabel;
}
