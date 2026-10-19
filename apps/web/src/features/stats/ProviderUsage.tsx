import { Badge, Button, Card, StatPlate } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { CapabilitiesInventory } from "./CapabilitiesInventory";
import { ProviderLogout } from "./ProviderLogout";
import { ProviderLogin } from "./ProviderLoginPanel";
import { signedOut } from "./providerLogin";
import { fmtCount, fmtDuration, fmtReset, sum, type ByModel, type CapabilitiesState, type Provider, type QuotaState, type QuotaStatus } from "./statsModel";

export function ModelUsageDetails({ model, providerTokens }: { model: ByModel; providerTokens?: number }) {
  const t = useT();
  const buckets = [
    { key: "ordinaryInput" as const, value: model.inputTokens, color: "bg-sky-400" },
    { key: "cacheRead" as const, value: model.cacheReadTokens, color: "bg-emerald-400" },
    { key: "cacheWrite" as const, value: model.cacheCreationTokens, color: "bg-violet-400" },
    { key: "outputTokens" as const, value: model.outputTokens, color: "bg-accent" },
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

export function ProviderUsage({
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
