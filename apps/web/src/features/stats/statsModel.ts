import type { MessageKey, Translate } from "../../shared/i18n";

export type Period = "day" | "yesterday" | "week" | "month";
export const PERIODS: Period[] = ["day", "yesterday", "week", "month"];

// Peon /api/v1/stats — flat SessionStats (peon sessions.ts). Every total is a
// top-level total* key; there is no `totals` wrapper. Rendered defensively so a
// missing field degrades to "—" rather than crashing.
export interface Stats {
  processedTokens?: number;
  usagePartialTurns?: number;
  usageLegacyTurns?: number;
  timeZone?: string;
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
    // Present only on Peons that attribute usage per turn. Older daemons still
    // credit a session's whole usage to whoever started it, which is a
    // different sentence to show the operator.
    usageTime?: string;
  };
}

export function usageIsPerTurn(...analytics: (Analytics | null)[]): boolean {
  return analytics.some((entry) => entry?.attribution?.usageTime === "transcript_result_created_at");
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
  cacheBreakdownComplete?: boolean;
  reasoningOutputTokens?: number | null;
  usagePartialTurns?: number;
  usageLegacyTurns?: number;
  agent?: Provider;
  model?: string;
  sessionCount?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalDurationMs?: number;
  totalCostUsd?: number;
}
// A Peon agent's service name (`claude-code`, `codex`, `opencode`, …).
export type Provider = string;
export type QuotaStatus = "ok" | "unavailable" | "error";

export interface ProviderQuota {
  provider: Provider;
  status: QuotaStatus;
  source: "oauth" | "cli-rpc" | "api" | null;
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

// What a Peon that publishes no catalog (an older one) is assumed to run.
export const PROVIDERS: Provider[] = ["claude-code", "codex"];
export const EMPTY_QUOTA_STATE: QuotaState = { data: null, loading: false, error: null };
export const EMPTY_CAPABILITIES_STATE: CapabilitiesState = { data: null, loading: false, error: null };

interface CatalogProvider {
  agent: string;
  serviceProvider?: string;
  capabilities?: { quota?: boolean; login?: boolean; logout?: boolean; loginKind?: string };
}

// The usage cards follow the Peon's own driver list. Older Peons omit
// `serviceProvider`; their only aliased driver is `codex-app-server` → `codex`.
export function serviceName(provider: CatalogProvider): Provider {
  return provider.serviceProvider ?? (provider.agent === "codex-app-server" ? "codex" : provider.agent);
}

export function statsProviders(catalog: { providers: CatalogProvider[] } | null): Provider[] {
  if (!catalog) return PROVIDERS;
  const names = catalog.providers.filter((provider) => provider.capabilities?.quota !== false).map(serviceName);
  return names.length ? [...new Set(names)] : PROVIDERS;
}

// Known providers have a translated name; an unknown one shows its own id.
export function providerName(t: Translate, provider: Provider): string {
  const key = `peon.quota.provider.${provider}` as MessageKey;
  const name = t(key);
  return name === key ? provider : name;
}

export function catalogProvider<T extends CatalogProvider>(catalog: { providers: T[] } | null, provider: Provider): T | null {
  return catalog?.providers.find((candidate) => serviceName(candidate) === provider) ?? null;
}

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
