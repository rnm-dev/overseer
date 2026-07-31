import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { Badge, Button, Card, StatPlate } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { CliUpdatesPanel } from "./CliUpdatesPanel";
import {
  EMPTY_CAPABILITIES,
  EMPTY_QUOTA,
  PERIODS,
  PROVIDERS,
  fmtCost,
  fmtCount,
  fmtCredit,
  fmtDuration,
  fmtReset,
  outcomeTone,
  sum,
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
} from "./statsModel.js";

// author: Viktor

export function PeonStats() {
  const t = useT();
  const { peon, base, isOwner } = usePeon();
  const [period, setPeriod] = useState<Period>("day");
  const [stats, setStats] = useState<Stats | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<Provider, QuotaState>>(EMPTY_QUOTA);
  const [capabilities, setCapabilities] = useState<Record<Provider, CapabilitiesState>>(EMPTY_CAPABILITIES);
  const [now, setNow] = useState(Date.now());

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
    let alive = true;
    setStats(null);
    setError(null);
    api<Stats>(`${base}/stats?period=${period}`)
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
  }, [base, peon.online, period, t]);

  if (!peon.online) return <p className="font-mono text-sm text-ink-faint">{t("peon.offlineNote")}</p>;
  if (unsupported) return <p className="font-mono text-sm text-ink-faint">{t("peon.unsupported")}</p>;

  const outcomes = stats?.outcomeCounts ? Object.entries(stats.outcomeCounts) : [];
  const missingUsage = stats?.sessionsMissingUsage ?? 0;
  // Output tokens + cost are the headline (below); input/cache are cheap and
  // cache_read dominates any raw total (it's context reread every turn, not new
  // work) — never headline a summed total, it reads as wildly inflated.
  const breakdown: [string, number | undefined][] = [
    ["peon.stats.inputTokens", stats?.totalInputTokens],
    ["peon.stats.cacheWrite", stats?.totalCacheCreationTokens],
    ["peon.stats.cacheRead", stats?.totalCacheReadTokens],
  ];
  const hasBreakdown = breakdown.some(([, n]) => typeof n === "number");
  const byModel = stats?.byModel ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1.5">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-sm border px-3 py-1.5 font-display text-[0.68rem] font-bold uppercase tracking-[0.12em] transition-colors ${
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatPlate value={fmtCount(stats.sessionCount)} label={t("peon.stats.sessions")} />
            <StatPlate value={fmtCount(stats.totalOutputTokens)} label={t("peon.stats.outputTokens")} tone="warning" />
            <StatPlate value={fmtCost(stats.totalCostUsd)} label={t("peon.stats.cost")} tone="ink" />
            <StatPlate value={fmtDuration(stats.totalDurationMs)} label={t("peon.stats.duration")} tone="ink" />
          </div>

          {missingUsage > 0 && <p className="font-mono text-xs text-ink-faint">{t("peon.stats.missingUsage", { n: missingUsage })}</p>}

          {hasBreakdown && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-muted">
              {breakdown.map(([key, n]) => (
                <span key={key}>
                  <span className="text-ink-faint">{t(key)}</span> {fmtCount(n)}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {PROVIDERS.map((provider) => (
          <ProviderUsage
            key={provider}
            provider={provider}
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

      {stats && (
        <Card className="px-5 py-4">
          <div className="mb-3 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">{t("peon.stats.outcomes")}</div>
          {outcomes.length === 0 ? (
            <p className="font-mono text-sm text-ink-faint">{t("peon.stats.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {outcomes.map(([outcome, n]) => (
                <li key={outcome} className="flex items-center justify-between gap-3">
                  <Badge tone={outcomeTone(outcome)}>{outcome.replace(/_/g, " ")}</Badge>
                  <span className="font-mono text-sm text-ink">{fmtCount(n)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function ProviderUsage({
  provider,
  quota,
  capabilities,
  models,
  now,
  onRefresh,
}: {
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
  const recordedCost = sum(models, "totalCostUsd");
  const recordedDuration = sum(models, "totalDurationMs");
  const quotaError = quota.error ?? (quota.data?.status === "error" ? quota.data.error : null);
  const credits = quota.data?.credits;
  const refreshing = quota.loading || capabilities.loading;

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

      {quotaError && <p className="mt-3 border-l-2 border-danger pl-3 font-mono text-xs text-danger">{quotaError}</p>}

      <section className="mt-5">
        <div className="mb-2 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">{t("peon.quota.recorded")}</div>
        <div className="grid grid-cols-3 gap-2">
          <StatPlate value={fmtCount(recordedTokens)} label={t("peon.quota.tokens")} tone="warning" />
          <StatPlate value={fmtCost(recordedCost)} label={t("peon.stats.cost")} tone="ink" />
          <StatPlate value={fmtDuration(recordedDuration)} label={t("peon.stats.duration")} tone="ink" />
        </div>
        {models.length === 0 ? (
          <p className="mt-3 font-mono text-xs text-ink-faint">{t("peon.quota.noRecorded")}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {models.map((model, index) => (
              <li key={`${model.model ?? "unknown"}-${index}`} className="flex items-center justify-between gap-3 font-mono text-xs">
                <span className="min-w-0 truncate text-ink">{model.model ?? "—"}</span>
                <span className="shrink-0 text-ink-faint">
                  {fmtCount(model.totalTokens)} · {fmtCost(model.totalCostUsd)} · {fmtDuration(model.totalDurationMs)}
                </span>
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

      {credits && Object.values(credits).some((value) => value !== undefined) && (
        <section className="mt-5 border-t border-edge pt-3 font-mono text-xs text-ink-muted">
          <div className="mb-2 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">{t("peon.quota.credits")}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {typeof credits.balance === "number" && <span>{t("peon.quota.balance")}: {fmtCredit(credits.balance, credits.currency)}</span>}
            {typeof credits.used === "number" && <span>{t("peon.quota.used")}: {fmtCredit(credits.used, credits.currency)}</span>}
            {typeof credits.limit === "number" && <span>{t("peon.quota.limit")}: {fmtCredit(credits.limit, credits.currency)}</span>}
          </div>
        </section>
      )}

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
        <ul className="divide-y divide-iron-800 pb-2">
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
