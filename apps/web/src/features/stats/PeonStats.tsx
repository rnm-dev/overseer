import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { Badge, Button, Card, StatPlate } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { usePeon } from "../fleet/context";
import { CliUpdatesPanel } from "../settings/CliUpdatesPanel";
import {
  EMPTY_CAPABILITIES,
  EMPTY_QUOTA,
  PERIODS,
  PROVIDERS,
  fmtBytes,
  fmtCount,
  fmtDuration,
  fmtReset,
  sum,
  analyticsRows,
  usageIsPerTurn,
  type Analytics,
  type AnalyticsRow,
  type ByModel,
  type CapabilitiesState,
  type CapabilityItem,
  type Period,
  type Provider,
  type ProviderCapabilities,
  type ProviderQuota,
  type QuotaState,
  type QuotaStatus,
  type Stats,
} from "./statsModel";

import { ProviderLogout } from "./ProviderLogout";
import { ProviderLogin } from "./ProviderLogin";
import { signedOut } from "./providerLogin";
import { useModels } from "../settings/models";

// author: Viktor
export const STATS_REFRESH_INTERVAL_MS = 15_000;

export function PeonStats() {
  const t = useT();
  const { peon, base, isOwner } = usePeon();
  const { catalog } = useModels(base);
  const [period, setPeriod] = useState<Period>("day");
  const [stats, setStats] = useState<Stats | null>(null);
  const [analytics, setAnalytics] = useState<{ users: Analytics | null; projects: Analytics | null }>({ users: null, projects: null });
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<Provider, QuotaState>>(EMPTY_QUOTA);
  const [capabilities, setCapabilities] = useState<Record<Provider, CapabilitiesState>>(EMPTY_CAPABILITIES);
  const [now, setNow] = useState(Date.now());
  const [statsRevision, setStatsRevision] = useState(0);

  const loadQuota = useCallback(
    (provider: Provider, refresh = false) => {
      setQuotas((current) => ({
        ...current,
        [provider]: { ...current[provider], loading: true, error: null },
      }));
      api<ProviderQuota>(`${base}/quota/${provider}${refresh ? "?refresh=1" : ""}`)
        .then((data) => {
          setQuotas((current) => ({ ...current, [provider]: { data, loading: false, error: null } }));
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : t("error.loadFailed");
          setQuotas((current) => ({ ...current, [provider]: { ...current[provider], loading: false, error: message } }));
        });
    },
    [base, t],
  );

  const loadCapabilities = useCallback(
    (provider: Provider, refresh = false) => {
      setCapabilities((current) => ({
        ...current,
        [provider]: { ...current[provider], loading: true, error: null },
      }));
      api<ProviderCapabilities>(`${base}/capabilities/${provider}${refresh ? "?refresh=1" : ""}`)
        .then((data) => {
          setCapabilities((current) => ({ ...current, [provider]: { data, loading: false, error: null } }));
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : t("error.loadFailed");
          setCapabilities((current) => ({
            ...current,
            [provider]: { ...current[provider], loading: false, error: message },
          }));
        });
    },
    [base, t],
  );

  useEffect(() => {
    if (!peon.online) return;
    // Deliberately launch both probes without awaiting either one.
    for (const provider of PROVIDERS) {
      loadQuota(provider);
      loadCapabilities(provider);
    }
  }, [loadCapabilities, loadQuota, peon.online]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!peon.online) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        setStatsRevision((value) => value + 1);
      }
    };
    const timer = window.setInterval(refreshWhenVisible, STATS_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [base, peon.online]);

  useEffect(() => {
    setStats(null);
    setAnalytics({ users: null, projects: null });
    setUnsupported(false);
  }, [base, period]);

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    setError(null);
    api<Stats>(`${base}/stats?period=${period}`, { cache: "no-store" })
      .then((s) => alive && setStats(s ?? {}))
      .catch((err) => {
        if (!alive) return;
        // A peon that predates /stats answers 404 — treat as "needs update".
        if (err instanceof ApiError && err.status === 404) setUnsupported(true);
        else setError(err instanceof Error ? err.message : t("error.loadFailed"));
      });
    return () => {
      alive = false;
    };
  }, [base, peon.online, period, statsRevision, t]);

  useEffect(() => {
    if (!peon.online || !stats || (stats.period && stats.period !== period)) return;
    let alive = true;
    setAnalytics({ users: null, projects: null });
    setAnalyticsError(null);
    const windowQuery = stats.rangeStart !== undefined && stats.rangeEnd !== undefined
      ? `from=${stats.rangeStart}&to=${stats.rangeEnd}` : `period=${period}`;
    Promise.allSettled([
      api<Analytics>(`${base}/analytics?${windowQuery}&groupBy=user`, { cache: "no-store" }),
      api<Analytics>(`${base}/analytics?${windowQuery}&groupBy=project`, { cache: "no-store" }),
    ]).then(([users, projects]) => {
      if (!alive) return;
      setAnalytics({
        users: users.status === "fulfilled" ? users.value : null,
        projects: projects.status === "fulfilled" ? projects.value : null,
      });
      if (users.status === "rejected" || projects.status === "rejected") {
        setAnalyticsError(t("error.loadFailed"));
      }
    });
    return () => {
      alive = false;
    };
  }, [base, peon.online, period, stats, t]);

  if (!peon.online) return <p className="font-mono text-sm text-ink-faint">{t("peon.offlineNote")}</p>;
  if (unsupported) return <p className="font-mono text-sm text-ink-faint">{t("peon.unsupported")}</p>;

  const missingUsage = stats?.sessionsMissingUsage ?? 0;
  // Canonical input/cache buckets are exclusive. Output includes reasoning;
  // processed usage includes repeated context, not just visible answer text.
  const breakdown: [string, number | undefined][] = [
    ["peon.stats.ordinaryInput", stats?.totalInputTokens],
    ["peon.stats.cacheWrite", stats?.totalCacheCreationTokens],
    ["peon.stats.cacheRead", stats?.totalCacheReadTokens],
    ["peon.stats.outputTokens", stats?.totalOutputTokens],
  ];
  const hasBreakdown = breakdown.some(([, n]) => typeof n === "number");
  const byModel = stats?.byModel ?? [];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" role="group">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={`min-h-10 whitespace-nowrap rounded-sm border px-4 py-2 font-display text-[0.68rem] font-bold uppercase tracking-[0.12em] transition-colors ${
              period === p ? "border-accent text-accent-strong" : "border-edge text-ink-muted hover:text-ink"
            }`}
          >
            {t(`peon.stats.period.${p}`)}
          </button>
        ))}
      </div>

      {error && <p className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {error}</p>}
      {!stats && !error && <div className="loading-spinner" />}
      {stats && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatPlate value={fmtCount(stats.sessionCount)} label={t("peon.stats.sessions")} />
            <StatPlate value={fmtCount(stats.processedTokens ?? stats.totalTokens)} label={t("peon.stats.processedTokens")} tone="warning" />
            <StatPlate value={fmtDuration(stats.totalDurationMs)} label={t("peon.stats.agentRuntime")} tone="ink" />
          </div>

          {missingUsage > 0 && <p className="font-mono text-xs text-ink-faint">{t("peon.stats.missingUsage", { n: missingUsage })}</p>}
          <p className="font-mono text-xs text-ink-faint">{t("peon.stats.usageExplanation")}</p>
          {((stats.usagePartialTurns ?? 0) > 0 || (stats.usageLegacyTurns ?? 0) > 0) &&
            <p className="font-mono text-xs text-ink-faint">{t("peon.stats.partialUsage")}</p>}
          {stats.timeZone && <p className="font-mono text-xs text-ink-faint">{t("peon.stats.timeZone", { zone: stats.timeZone })}</p>}

          {hasBreakdown && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-muted">
              {breakdown.map(([key, n]) => (
                <span key={key}>
                  <span className="text-ink-faint">{t(key)}</span> {fmtCount(n)}
                </span>
              ))}
            </div>
          )}
          <div className="font-mono text-xs text-ink-muted">
            <span className="text-ink-faint">{t("peon.stats.stateSize")}</span> {fmtBytes(stats.sessionsSizeBytes)}
          </div>
        </>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <UsageBreakdown
          title={t("peon.stats.byUser")}
          rows={analytics.users?.rows}
          label={(row) => row.user === "unknown" || !row.user ? t("peon.stats.unknownUser") : row.user}
          empty={t("peon.stats.noUserUsage")}
          loading={!analytics.users && !analyticsError}
        />
        <UsageBreakdown
          title={t("peon.stats.byProject")}
          rows={analytics.projects?.rows}
          label={(row) => row.projectKey || (row.projectId ? row.projectId : t("peon.stats.unknownProject"))}
          empty={t("peon.stats.noProjectUsage")}
          loading={!analytics.projects && !analyticsError}
        />
      </div>
      {analyticsError && <p className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {t("peon.stats.breakdownUnavailable")}</p>}
      {(analytics.users?.attribution?.note || analytics.projects?.attribution?.note) && (
        <p className="font-mono text-xs text-ink-faint">
          {t(usageIsPerTurn(analytics.users, analytics.projects) ? "peon.stats.attributionNote" : "peon.stats.attributionNoteLegacy")}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {PROVIDERS.map((provider) => (
          <ProviderUsage
            key={provider}
            provider={provider}
            base={base}
            canLogin={isOwner && catalog?.providers.some((p) => p.agent === (provider === "codex" ? "codex-app-server" : provider) && p.capabilities?.login === true) === true}
            canLogout={isOwner && catalog?.providers.some((p) => p.agent === (provider === "codex" ? "codex-app-server" : provider) && p.capabilities?.logout === true) === true}
            quota={quotas[provider]}
            capabilities={capabilities[provider]}
            models={byModel.filter((model) => model.agent === provider)}
            now={now}
            onRefresh={() => {
              loadQuota(provider, true);
              loadCapabilities(provider, true);
            }}
          />
        ))}
      </div>

      {isOwner && <CliUpdatesPanel base={base} online={peon.online} />}
    </div>
  );
}

function UsageBreakdown({
  title,
  rows,
  label,
  empty,
  loading,
}: {
  title: string;
  rows?: AnalyticsRow[];
  label: (row: AnalyticsRow) => string;
  empty: string;
  loading: boolean;
}) {
  const t = useT();
  const ordered = analyticsRows(rows);
  return (
    <Card className="overflow-hidden px-0 py-0">
      <div className="border-b border-edge px-5 py-4 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">{title}</div>
      {loading ? <div className="m-5 loading-spinner" /> : ordered.length === 0 ? (
        <p className="px-5 py-6 font-mono text-sm text-ink-faint">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left font-mono text-xs">
            <thead className="text-ink-faint">
              <tr className="border-b border-edge">
                <th className="px-5 py-2 font-normal">{t("peon.stats.name")}</th>
                <th className="px-3 py-2 text-right font-normal">{t("peon.stats.prompts")}</th>
                <th className="px-3 py-2 text-right font-normal">{t("peon.stats.outputTokens")}</th>
                <th className="px-5 py-2 text-right font-normal">{t("peon.stats.inputTokens")}</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((row, index) => (
                <tr key={`${label(row)}-${index}`} className="border-b border-edge/60 last:border-0">
                  <td className="max-w-56 truncate px-5 py-3 text-ink" title={label(row)}>{label(row)}</td>
                  <td className="px-3 py-3 text-right text-ink-muted">{fmtCount(row.promptCount)}</td>
                  <td className="px-3 py-3 text-right text-accent-strong">{fmtCount(row.outputTokens)}</td>
                  <td className="px-5 py-3 text-right text-ink-muted">{fmtCount(row.inputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function ModelUsageDetails({ model, providerTokens }: { model: ByModel; providerTokens?: number }) {
  const t = useT();
  const buckets = [
    { key: "ordinaryInput", value: model.inputTokens, color: "bg-sky-400" },
    { key: "cacheRead", value: model.cacheReadTokens, color: "bg-emerald-400" },
    { key: "cacheWrite", value: model.cacheCreationTokens, color: "bg-violet-400" },
    { key: "outputTokens", value: model.outputTokens, color: "bg-accent" },
  ];
  const completeBreakdown = model.cacheBreakdownComplete !== false && buckets.every((bucket) => typeof bucket.value === "number" && Number.isFinite(bucket.value));
  const input = (model.inputTokens ?? 0) + (model.cacheReadTokens ?? 0) + (model.cacheCreationTokens ?? 0);
  const cacheRate = completeBreakdown && input > 0 ? (model.cacheReadTokens ?? 0) / input * 100 : null;
  const share = providerTokens && typeof model.totalTokens === "number" ? model.totalTokens / providerTokens * 100 : null;
  const quality = (model.usagePartialTurns ?? 0) > 0 ? "partial"
    : model.usageLegacyTurns === undefined || model.usageLegacyTurns > 0 ? "legacy" : "reported";
  return (
    <div className="min-w-0 rounded-md border border-edge bg-surface-raised/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-36">
          <div className="break-all font-mono text-xs font-semibold text-ink">{model.model ?? "—"}</div>
          <div className="mt-1 font-mono text-[0.65rem] text-ink-faint">{t(`peon.stats.quality.${quality}`)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-lg font-semibold tabular-nums text-accent-strong">{fmtCount(model.totalTokens)}</div>
          {share !== null && <div className="font-mono text-[0.6rem] text-ink-faint">{share.toFixed(1)}% {t("peon.stats.providerShare")}</div>}
        </div>
      </div>
      {completeBreakdown && (model.totalTokens ?? 0) > 0 && (
        <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-surface-raised" aria-hidden="true">
          {buckets.map((bucket) => <span key={bucket.key} className={bucket.color}
            style={{ width: `${Math.max(0, Math.min(100, (bucket.value ?? 0) / model.totalTokens! * 100))}%` }} />)}
        </div>
      )}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 min-[400px]:grid-cols-2">
        {buckets.map((bucket) => <div key={bucket.key} className="flex min-w-0 items-center justify-between gap-2 font-mono text-[0.65rem]">
          <dt className="flex min-w-0 items-center gap-1.5 text-ink-faint"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bucket.color}`} />{t(`peon.stats.${bucket.key}`)}</dt>
          <dd className="shrink-0 tabular-nums text-ink-muted">{fmtCount(bucket.value)}</dd>
        </div>)}
      </dl>
      {cacheRate !== null && <div className="mt-3 flex flex-wrap justify-between gap-2 border-t border-edge pt-2 font-mono text-[0.65rem]">
        <span className="text-ink-faint">{t("peon.stats.cacheEfficiency")}</span>
        <span className="text-emerald-400">{cacheRate.toFixed(1)}%</span>
      </div>}
      {model.cacheBreakdownComplete === false && <p className="mt-2 font-mono text-[0.65rem] text-ink-faint">{t("peon.stats.cacheIncomplete")}</p>}
      {typeof model.reasoningOutputTokens === "number" && <p className="mt-2 font-mono text-[0.65rem] text-ink-faint">{t("peon.stats.reasoningSubset", { n: fmtCount(model.reasoningOutputTokens) })}</p>}
    </div>
  );
}

function ProviderUsage({
  base, canLogin, canLogout,
  provider,
  quota,
  capabilities,
  models,
  now,
  onRefresh,
}: {
  base: string; canLogin: boolean; canLogout: boolean;
  provider: Provider;
  quota: QuotaState;
  capabilities: CapabilitiesState;
  models: ByModel[];
  now: number;
  onRefresh: () => void;
}) {
  const t = useT();
  const effectiveStatus: QuotaStatus = quota.error ? "error" : quota.data?.status ?? "unavailable";
  const statusTone = effectiveStatus === "ok" ? "green" : effectiveStatus === "error" ? "red" : "neutral";
  const statusLabel = quota.loading && !quota.data ? t("peon.quota.status.checking") : t(`peon.quota.status.${effectiveStatus}`);
  const providerName = t(`peon.quota.provider.${provider}`);
  const recordedTokens = sum(models, "totalTokens");
  const recordedDuration = sum(models, "totalDurationMs");
  const quotaError = quota.error ?? quota.data?.error ?? null;
  const refreshing = quota.loading || capabilities.loading;

  // Peon has no authoritative "this CLI is installed" signal — both drivers report
  // available() === true unconditionally. So an absent agent is recognised by its
  // probes settling with nothing at all: no account, no limits, no capabilities,
  // no usage. Hydrating that into zeroed plates and a red `spawn claude ENOENT`
  // reads as a broken card; one empty state says the true thing instead.
  const settled = Boolean(quota.data ?? quota.error) && Boolean(capabilities.data ?? capabilities.error);
  const capabilityCount =
    (capabilities.data?.plugins.length ?? 0) + (capabilities.data?.skills.length ?? 0) + (capabilities.data?.mcps.length ?? 0);
  const absent =
    settled &&
    effectiveStatus !== "ok" &&
    (quota.data?.windows.length ?? 0) === 0 &&
    capabilityCount === 0 &&
    models.length === 0;
  const absentReason = quotaError ?? capabilities.error ?? capabilities.data?.error ?? null;

  const needsLogin = signedOut(quotaError);
  const login = canLogin && needsLogin ? <ProviderLogin key={`${base}/${provider}`} base={base} provider={provider} onSuccess={onRefresh} /> : null;

  if (absent && !needsLogin) {
    return (
      <Card className="flex min-h-80 flex-col px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-ink-muted">{providerName}</h3>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? t("peon.quota.refreshing") : t("peon.quota.refresh")}
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
          <p className="font-display text-sm font-medium text-ink">{t("peon.quota.absent.title", { provider: providerName })}</p>
          <p className="max-w-xs font-mono text-xs text-ink-faint">{t("peon.quota.absent.body")}</p>
          {absentReason && <p className="max-w-xs break-words font-mono text-[0.68rem] text-ink-faint/70">{absentReason}</p>}
        </div>
      </Card>
    );
  }

  return (
    <Card className="flex min-h-80 flex-col px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-ink">{providerName}</h3>
            <Badge tone={statusTone}>{statusLabel}</Badge>
          </div>
          {quota.data?.accountEmail && (
            <p className="mt-1 font-mono text-xs text-ink-muted">{t("peon.quota.signedIn", { email: quota.data.accountEmail })}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? t("peon.quota.refreshing") : t("peon.quota.refresh")}
        </Button>
      </div>

      {canLogout && !needsLogin && (quota.data?.status === "ok" || Boolean(quota.data?.accountEmail)) && <ProviderLogout key={`${base}/${provider}`} base={base} provider={provider} onSuccess={onRefresh} />}
      {login}
      {quotaError && !needsLogin && <p className="mt-3 border-l-2 border-danger pl-3 font-mono text-xs text-danger">{quotaError}</p>}

      <section className="mt-5">
        <div className="mb-2 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">{t("peon.quota.recorded")}</div>
        <div className="grid grid-cols-2 gap-2">
          <StatPlate value={fmtCount(recordedTokens)} label={t("peon.quota.tokens")} tone="warning" />
          <StatPlate value={fmtDuration(recordedDuration)} label={t("peon.stats.agentRuntime")} tone="ink" />
        </div>
        {models.length === 0 ? (
          <p className="mt-3 font-mono text-xs text-ink-faint">{t("peon.quota.noRecorded")}</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {models.map((model, index) => (
              <li key={`${model.model ?? "unknown"}-${index}`}>
                <ModelUsageDetails model={model} providerTokens={recordedTokens} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-5">
        <div className="mb-2 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">{t("peon.quota.accountLimits")}</div>
        {quota.loading && !quota.data ? (
          <div className="loading-spinner" />
        ) : (quota.data?.windows.length ?? 0) === 0 ? (
          <p className="font-mono text-xs text-ink-faint">{t("peon.quota.noLimits")}</p>
        ) : (
          <ul className="space-y-3">
            {quota.data?.windows.map((window) => {
              const percent = Math.max(0, Math.min(100, window.usedPercent));
              return (
                <li key={window.id}>
                  <div className="mb-1 flex items-center justify-between gap-3 font-mono text-xs">
                    <span className="text-ink">
                      {window.label}
                      {window.modelIds?.length ? <span className="ml-1 text-ink-faint">· {window.modelIds.join(", ")}</span> : null}
                    </span>
                    <span className="shrink-0 text-ink-muted">{window.usedPercent.toFixed(0)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-sm bg-surface-raised">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
                  </div>
                  <div className="mt-1 font-mono text-[0.68rem] text-ink-faint">
                    {t("peon.quota.resets", { countdown: fmtReset(window.resetsAt, now) })}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <CapabilitiesInventory state={capabilities} />
    </Card>
  );
}

function CapabilitiesInventory({ state }: { state: CapabilitiesState }) {
  const t = useT();
  const inventory = state.data;
  const groups: Array<{ key: "plugins" | "skills" | "mcps"; items: CapabilityItem[] }> = [
    { key: "plugins", items: inventory?.plugins ?? [] },
    { key: "skills", items: inventory?.skills ?? [] },
    { key: "mcps", items: inventory?.mcps ?? [] },
  ];
  const hasItems = groups.some((group) => group.items.length > 0);
  const inventoryError = state.error ?? inventory?.error ?? null;
  const partial = Boolean(inventoryError && hasItems);

  return (
    <section className="mt-5 border-t border-edge pt-4">
      <div className="mb-2 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">
        {t("peon.capabilities.inventory")}
      </div>
      {state.loading && !inventory ? (
        <div className="loading-spinner" />
      ) : (
        <>
          {inventoryError && (
            <p className={`mb-3 border-l-2 pl-3 font-mono text-xs ${partial ? "border-warning text-warning" : "border-danger text-danger"}`}>
              {partial ? `${t("peon.capabilities.partial")}: ` : ""}{inventoryError}
            </p>
          )}
          {groups.map((group) => (
            <CapabilityGroup key={group.key} label={t(`peon.capabilities.${group.key}`)} items={group.items} />
          ))}
        </>
      )}
    </section>
  );
}

function CapabilityGroup({ label, items }: { label: string; items: CapabilityItem[] }) {
  const t = useT();
  return (
    <details className="border-t border-edge first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 font-display text-xs font-medium text-ink marker:hidden">
        <span>{label}</span>
        <span className="rounded-sm bg-surface-raised px-2 py-0.5 font-mono text-[0.68rem] text-ink-muted">{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <p className="pb-3 font-mono text-xs text-ink-faint">{t("peon.capabilities.empty")}</p>
      ) : (
        <ul className="divide-y divide-edge pb-2">
          {items.map((item) => (
            <li key={item.id} className="py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words font-mono text-xs text-ink">{item.name}</span>
                <Badge tone={item.enabled ? "green" : "neutral"}>
                  {t(item.enabled ? "peon.capabilities.enabled" : "peon.capabilities.disabled")}
                </Badge>
              </div>
              {(item.version || item.source || item.transport) && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem] text-ink-faint">
                  {item.version && <span>{t("peon.capabilities.version")}: {item.version}</span>}
                  {item.source && <span>{t("peon.capabilities.source")}: {item.source}</span>}
                  {item.transport && <span>{t("peon.capabilities.transport")}: {item.transport}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
