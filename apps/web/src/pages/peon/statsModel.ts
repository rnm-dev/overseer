export type Period = "day" | "yesterday" | "week" | "month";
export const PERIODS: Period[] = ["day", "yesterday", "week", "month"];

// Peon /api/v1/stats — flat SessionStats (peon sessions.ts). Every total is a
// top-level total* key; there is no `totals` wrapper. Rendered defensively so a
// missing field degrades to "—" rather than crashing.
export interface Stats {
  period?: string;
  rangeStart?: number;
  rangeEnd?: number;
  sessionsSizeBytes?: number;
  sessionCount?: number;
  outcomeCounts?: Record<string, number>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalTokens?: number; // already includes cache tokens — never re-sum components
  totalDurationMs?: number;
  totalCostUsd?: number;
  sessionsWithUsage?: number;
  sessionsMissingUsage?: number;
  byModel?: ByModel[];
}

export interface AnalyticsRow {
  user?: string;
  projectId?: string | null;
  projectKey?: string | null;
  sessionCount?: number;
  promptCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  processedTokens?: number;
  sessionsMissingUsage?: number;
}

export interface Analytics {
  rows?: AnalyticsRow[];
  attribution?: {
    note?: string;
  };
}

export function analyticsRows(rows?: AnalyticsRow[]): AnalyticsRow[] {
  return [...(rows ?? [])].sort((a, b) =>
    (b.outputTokens ?? 0) - (a.outputTokens ?? 0)
      || (b.promptCount ?? 0) - (a.promptCount ?? 0),
  );
}
// Per-model usage rollup — attributed to the model actually used per turn, sorted
// by cost server-side. Rendered defensively (any field may be absent).
export interface ByModel {
  agent?: Provider;
  model?: string;
  sessionCount?: number;
  totalTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationTokens?: number;
  totalCacheReadTokens?: number;
  totalDurationMs?: number;
  totalCostUsd?: number;
}
export type Provider = "claude-code" | "codex";
export type QuotaStatus = "ok" | "unavailable" | "error";

export interface ProviderQuota {
  provider: Provider;
  status: QuotaStatus;
  source: "oauth" | "cli-rpc" | null;
  updatedAt: number;
  accountEmail?: string;
  windows: Array<{
    id: string;
    label: string;
    usedPercent: number;
    resetsAt: number | null;
    modelIds?: string[];
  }>;
  credits?: {
    balance?: number;
    used?: number;
    limit?: number;
    currency?: string;
  };
  error?: string;
}

export interface QuotaState {
  data: ProviderQuota | null;
  loading: boolean;
  error: string | null;
}

export interface CapabilityItem {
  id: string;
  name: string;
  enabled: boolean;
  source?: string;
  version?: string;
  transport?: string;
}

export interface ProviderCapabilities {
  provider: Provider;
  status: "ok" | "error";
  updatedAt: number;
  plugins: CapabilityItem[];
  skills: CapabilityItem[];
  mcps: CapabilityItem[];
  error?: string;
}

export interface CapabilitiesState {
  data: ProviderCapabilities | null;
  loading: boolean;
  error: string | null;
}

export const PROVIDERS: Provider[] = ["claude-code", "codex"];
export const EMPTY_QUOTA: Record<Provider, QuotaState> = {
  "claude-code": { data: null, loading: false, error: null },
  codex: { data: null, loading: false, error: null },
};
export const EMPTY_CAPABILITIES: Record<Provider, CapabilitiesState> = {
  "claude-code": { data: null, loading: false, error: null },
  codex: { data: null, loading: false, error: null },
};

export const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function fmtCount(n?: number): string {
  return typeof n === "number" ? compact.format(n) : "—";
}
export function fmtBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
export function fmtDuration(ms?: number): string {
  if (typeof ms !== "number" || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function sum(models: ByModel[], field: keyof ByModel): number | undefined {
  const values = models.map((model) => model[field]).filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

export function fmtReset(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "—";
  const remaining = Math.max(0, resetsAt - now);
  if (remaining === 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}


