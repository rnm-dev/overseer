import { Check, KeyRound, PackagePlus, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { Button } from "../../../ui";
import { useI18n } from "../../../i18n";
import type { PluginInstallInquiry } from "./pluginInquiries";

export const PLUGIN_INQUIRY_CARD_CLASS = "plugin-inquiry-card surface mr-auto w-full max-w-md overflow-hidden p-3 sm:p-4";
export const PLUGIN_INQUIRY_ACTIONS_CLASS = "mt-3 grid grid-cols-2 gap-2 max-[360px]:grid-cols-1";

const tone = {
  installed: { icon: Check, color: "text-accent-strong" },
  auth_required: { icon: KeyRound, color: "text-warning-strong" },
  failed: { icon: TriangleAlert, color: "text-danger" },
  stale: { icon: TriangleAlert, color: "text-warning-strong" },
  expired: { icon: X, color: "text-ink-faint" },
  cancelled: { icon: X, color: "text-ink-faint" },
  refused: { icon: X, color: "text-danger" },
} as const;

export function PluginInquiryCard({ inquiry, authHrefForApp, onInstall, onCancel }: {
  inquiry: PluginInstallInquiry;
  authHrefForApp: (appId: string) => string;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pending = inquiry.status === "pending";
  const installing = inquiry.status === "installing";
  const terminal = tone[inquiry.status as keyof typeof tone];
  const Icon = terminal?.icon ?? (pending || installing ? PackagePlus : ShieldCheck);
  return (
    <section className={PLUGIN_INQUIRY_CARD_CLASS} aria-labelledby={`plugin-inquiry-${inquiry.inquiryId}`} aria-live="polite" data-plugin-inquiry-status={inquiry.status}>
      <div className="flex items-start gap-2.5">
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg bg-surface-hover ${terminal?.color ?? "text-accent-strong"}`} aria-hidden="true">
          <Icon size={16} className={installing ? "animate-pulse motion-reduce:animate-none" : ""} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-ink-faint">{inquiry.plugin.category ?? t("pluginInquiry.managed")}</p>
          <h3 id={`plugin-inquiry-${inquiry.inquiryId}`} className="truncate font-display text-sm font-bold text-ink">{inquiry.plugin.displayName}</h3>
          <p className="truncate text-xs text-ink-muted">{inquiry.plugin.developerName ?? inquiry.plugin.name}</p>
        </div>
        <span className={`shrink-0 text-xs font-medium ${terminal?.color ?? "text-ink-muted"}`}>{t(`pluginInquiry.status.${inquiry.status}`)}</span>
      </div>
      {pending && <p className="mt-2.5 text-sm text-ink-muted">{t("pluginInquiry.action")}</p>}
      {pending && (
        <div className={PLUGIN_INQUIRY_ACTIONS_CLASS}>
          <Button variant="secondary" size="sm" onClick={onCancel}>{t("action.cancel")}</Button>
          <Button size="sm" onClick={onInstall}>{t("pluginInquiry.install")}</Button>
        </div>
      )}
      {inquiry.status === "auth_required" && (
        <div className="mt-3 flex flex-wrap justify-start gap-2">
          {inquiry.appsNeedingAuth.map((app) => (
            <a key={app.id} className="btn btn-accent btn-sm" href={authHrefForApp(app.id)} target="_blank" rel="noreferrer">
              {inquiry.appsNeedingAuth.length > 1 ? t("pluginInquiry.signInTo", { app: app.name }) : t("pluginInquiry.signIn")}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

export function PluginInquiryLoading({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 rounded-xl border border-edge bg-surface-raised px-4 py-3 text-sm text-ink-muted" role={failed ? "alert" : "status"}>
      <span>{t(failed ? "pluginInquiry.loadFailed" : "pluginInquiry.loading")}</span>
      {failed && <Button variant="ghost" size="sm" onClick={onRetry}>{t("pluginInquiry.retry")}</Button>}
    </div>
  );
}
