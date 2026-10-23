import { LogOut, MoreVertical, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Badge, Card, DropdownMenu, menuItemClass, toolbarItemClass } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { ProviderLogoutDialog } from "./ProviderLogout";
import { ProviderLogin } from "./ProviderLoginPanel";
import { signedOut } from "./providerLogin";
import { fmtReset, type ByModel, type CapabilitiesState, type Provider, type QuotaState, type QuotaStatus } from "./statsModel";

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
  const [confirmLogout, setConfirmLogout] = useState(false);
  const effectiveStatus: QuotaStatus = quota.error ? "error" : quota.data?.status ?? "unavailable";
  const statusTone = effectiveStatus === "ok" ? "green" : effectiveStatus === "error" ? "red" : "neutral";
  const statusLabel = quota.loading && !quota.data ? t("peon.quota.status.checking") : t(`peon.quota.status.${effectiveStatus}`);
  const providerName = t(`peon.quota.provider.${provider}`);
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
      <Card className="relative flex flex-col py-4 pl-5 pr-12">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-ink-muted">{providerName}</h3>
          <ProviderMenu refreshing={refreshing} onRefresh={onRefresh} />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6 text-center">
          <p className="font-display text-sm font-medium text-ink">{t("peon.quota.absent.title", { provider: providerName })}</p>
          {absentReason && <p className="max-w-xs break-words font-mono text-[0.68rem] text-ink-faint/70">{absentReason}</p>}
        </div>
      </Card>
    );
  }

  return (
    <Card className="relative flex flex-col gap-4 py-4 pl-5 pr-12 sm:flex-row sm:items-start sm:justify-between">
      <ProviderMenu
        refreshing={refreshing}
        onRefresh={onRefresh}
        onLogout={canLogout && !needsLogin && (quota.data?.status === "ok" || Boolean(quota.data?.accountEmail)) ? () => setConfirmLogout(true) : undefined}
      />
      {confirmLogout && <ProviderLogoutDialog base={base} provider={provider} onSuccess={onRefresh} onClose={() => setConfirmLogout(false)} />}
      <div className="min-w-0 sm:max-w-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-sm font-bold uppercase tracking-[0.12em] text-ink">{providerName}</h3>
          {(effectiveStatus !== "ok" || (quota.loading && !quota.data)) && <Badge tone={statusTone}>{statusLabel}</Badge>}
        </div>
        {quota.data?.accountEmail && (
          <p className="mt-1 truncate font-mono text-xs text-ink-muted">{quota.data.accountEmail}</p>
        )}
        {login}
        {quotaError && !needsLogin && <p className="mt-3 border-l-2 border-danger pl-3 font-mono text-xs text-danger">{quotaError}</p>}
      </div>

      {!needsLogin && <section aria-label={t("peon.quota.accountLimits")} className="sm:shrink-0">
        {quota.loading && !quota.data ? (
          <div className="loading-spinner" />
        ) : (quota.data?.windows.length ?? 0) === 0 ? (
          <p className="font-mono text-xs text-ink-faint">{t("peon.quota.noLimits")}</p>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-4 sm:justify-end">
            {quota.data?.windows.map((window) => (
              <li key={window.id} className="flex w-28 flex-col items-center text-center">
                <LimitRing percent={window.usedPercent} />
                <span className="mt-2 line-clamp-2 font-mono text-xs text-ink" title={window.modelIds?.length ? window.modelIds.join(", ") : undefined}>{window.label}</span>
                <span className="mt-0.5 font-mono text-[0.65rem] text-ink-faint">{t("peon.quota.resets", { countdown: fmtReset(window.resetsAt, now) })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>}
    </Card>
  );
}

/** Kebab menu floating in the card's top-right corner. */
function ProviderMenu({ refreshing, onRefresh, onLogout }: { refreshing: boolean; onRefresh: () => void; onLogout?: () => void }) {
  const t = useT();
  return (
    <DropdownMenu
      label={t("peon.quota.actions")}
      className="!absolute right-2 top-2"
      buttonClassName={toolbarItemClass(false, true)}
      menuWidthClassName="w-40"
      trigger={refreshing ? <RefreshCw size={14} className="animate-spin" aria-hidden /> : <MoreVertical size={15} aria-hidden />}
    >
      {(close) => <>
        <button type="button" role="menuitem" disabled={refreshing} className={`${menuItemClass()} !flex items-center gap-2`} onClick={() => { close(); onRefresh(); }}>
          <RefreshCw size={13} aria-hidden />{refreshing ? t("peon.quota.refreshing") : t("peon.quota.refresh")}
        </button>
        {onLogout && <button type="button" role="menuitem" className={`${menuItemClass("danger")} !flex items-center gap-2`} onClick={() => { close(); onLogout(); }}>
          <LogOut size={13} aria-hidden />{t("providerLogin.logout")}
        </button>}
      </>}
    </DropdownMenu>
  );
}

/** A ring that fills clockwise with the share of the limit already used. */
function LimitRing({ percent }: { percent: number }) {
  const value = Math.max(0, Math.min(100, percent));
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const tone = value >= 90 ? "text-danger" : value >= 70 ? "text-warning" : "text-accent";
  return (
    <div className="relative h-16 w-16" role="img" aria-label={`${value.toFixed(0)}%`}>
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="32" cy="32" r={radius} fill="none" strokeWidth="6" className="stroke-ink/10" />
        <circle
          cx="32" cy="32" r={radius} fill="none" strokeWidth="6" strokeLinecap="round"
          stroke="currentColor"
          className={`${tone} transition-[stroke-dashoffset] duration-500`}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - value / 100)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center font-display text-sm font-semibold tabular-nums text-ink">{value.toFixed(0)}%</span>
    </div>
  );
}
