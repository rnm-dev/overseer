import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { useApiResource } from "../../shared/useApiResource";
import { Card, StatPlate } from "../../shared/ui";
import { useT, type MessageKey } from "../../shared/i18n";
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
  analyticsRows,
  usageIsPerTurn,
  type Analytics,
  type AnalyticsRow,
  type CapabilitiesState,
  type Period,
  type Provider,
  type ProviderCapabilities,
  type ProviderQuota,
  type QuotaState,
  type Stats,
} from "./statsModel";

import { ProviderUsage } from "./ProviderUsage";
import { useModels } from "../fleet/modelsCatalog";

// author: Viktor
export const STATS_REFRESH_INTERVAL_MS = 15_000;

export function PeonStats() {
  const t = useT();
  const { peon, base, isOwner } = usePeon();
  const { catalog } = useModels(base);
  const [period, setPeriod] = useState<Period>("day");
  const [analytics, setAnalytics] = useState<{ users: Analytics | null; projects: Analytics | null }>({ users: null, projects: null });
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<Provider, QuotaState>>(EMPTY_QUOTA);
  const [capabilities, setCapabilities] = useState<Record<Provider, CapabilitiesState>>(EMPTY_CAPABILITIES);
  const [now, setNow] = useState(Date.now());
  const [statsRevision, setStatsRevision] = useState(0);
  const statsResource = useApiResource<Stats>(peon.online ? `${base}/stats?period=${period}` : null, [statsRevision], { cache: "no-store" });
  // A 204 still counts as loaded (empty) stats.
  const stats = useMemo(() => statsResource.data === undefined ? {} as Stats : statsResource.data, [statsResource.data]);
  // A peon that predates /stats answers 404 — treat as "needs update".
  const unsupported = statsResource.error instanceof ApiError && statsResource.error.status === 404;
  const error = statsResource.error && !unsupported ? (statsResource.error instanceof Error ? statsResource.error.message : t("error.loadFailed")) : null;

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
    setAnalytics({ users: null, projects: null });
  }, [base, period]);

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
  const breakdown: [MessageKey, number | undefined][] = [
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
