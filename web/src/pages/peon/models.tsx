import { useEffect, useState } from "react";
import { api, isPeonNeedsUpdate } from "../../api";

// author: Viktor

// Peon /agent/v1/models — the model catalog + the peon's global default.
export interface ModelOption {
  id: string;
  label: string;
  alias?: string;
}
export interface ModelProvider {
  agent: string;
  label: string;
  models: ModelOption[];
}
export interface ModelsCatalog {
  providers: ModelProvider[];
  defaultModel: string | null;
}

// Per-model usage rollup on a SessionRecord (usageByModel[modelId]).
export interface SessionUsage {
  totalTokens?: number;
  totalCostUsd?: number;
}

// Loads the catalog for a peon. `supported` flips false once we learn the peon
// predates /models (404) — callers then hide the picker and fall back to the
// peon's own default. A null catalog means "still loading".
export function useModels(base: string): { catalog: ModelsCatalog | null; supported: boolean } {
  const [catalog, setCatalog] = useState<ModelsCatalog | null>(null);
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    let alive = true;
    setCatalog(null);
    setSupported(true);
    api<ModelsCatalog>(`${base}/models`)
      .then((c) => alive && setCatalog({ providers: c.providers ?? [], defaultModel: c.defaultModel ?? null }))
      .catch((err) => {
        if (alive && isPeonNeedsUpdate(err)) setSupported(false);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  return { catalog, supported };
}

// Human label for a model id/alias via the catalog (falls back to the raw id).
export function modelLabel(catalog: ModelsCatalog | null, id: string | null | undefined): string | null {
  if (!id) return null;
  for (const p of catalog?.providers ?? []) for (const m of p.models) if (m.id === id || m.alias === id) return m.label;
  return id;
}

// A <select> over the catalog, grouped by provider. The empty value means "no
// explicit model" — send nothing, follow the session/peon default.
export function ModelSelect({
  catalog,
  value,
  onChange,
  defaultLabel,
  className = "",
}: {
  catalog: ModelsCatalog;
  value: string;
  onChange: (v: string) => void;
  defaultLabel: string;
  className?: string;
}) {
  return (
    <select className={`warp-select ${className}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{defaultLabel}</option>
      {catalog.providers.map((p) => (
        <optgroup key={p.agent} label={p.label}>
          {p.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
