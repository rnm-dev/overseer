import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, isPeonNeedsUpdate } from "../../shared/api";
import { Badge, Button, Card } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { cliUpdateBusy, normalizeCliUpdates, type CliProvider, type CliUpdateItem } from "./cliUpdates";

interface Props {
  base: string;
  online: boolean;
}

const labels: Record<CliProvider, string> = { codex: "Codex CLI", "claude-code": "Claude Code" };

export function CliUpdatesPanel({ base, online }: Props) {
  const t = useT();
  const [items, setItems] = useState<CliUpdateItem[]>([]);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState<CliProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (!online) return;
    if (refresh) setRefreshing(true);
    try {
      const raw = await api<unknown>(`${base}/ai/cli-updates${refresh ? "?refresh=true" : ""}`, { cache: "no-store" });
      setItems(normalizeCliUpdates(raw));
      setSupported(true);
      setError(null);
    } catch (err) {
      if (isPeonNeedsUpdate(err)) setSupported(false);
      else setError(err instanceof Error ? err.message : t("error.generic"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [base, online, t]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const busy = useMemo(() => items.some((item) => cliUpdateBusy(item.status)), [items]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  async function start(provider: CliProvider) {
    setStarting(provider);
    setError(null);
    setItems((current) => current.map((item) => item.provider === provider ? { ...item, status: "queued", error: null } : item));
    try {
      await api(`${base}/ai/cli-updates/${encodeURIComponent(provider)}`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await load();
      else {
        setItems((current) => current.map((item) => item.provider === provider ? { ...item, status: "idle" } : item));
        setError(err instanceof Error ? err.message : t("error.generic"));
      }
    } finally {
      setStarting(null);
    }
  }

  if (!online) return null;

  return (
    <Card className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-display text-sm font-bold text-ink">{t("peon.cliUpdates.title")}</h3>
          <p className="mt-1 font-mono text-xs text-ink-muted">{t("peon.cliUpdates.hint")}</p>
        </div>
        {supported && <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={loading || refreshing || busy}>{refreshing ? t("peon.cliUpdates.refreshing") : t("peon.cliUpdates.refresh")}</Button>}
      </div>

      {!supported ? (
        <p className="font-mono text-xs text-ink-faint">{t("peon.cliUpdates.unsupported")}</p>
      ) : loading ? (
        <p role="status" className="font-mono text-xs text-ink-faint">{t("app.loading")}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((item) => {
            const active = cliUpdateBusy(item.status) || starting === item.provider;
            const failed = ["failed", "failure"].includes(item.status.toLowerCase());
            const available = item.updateAvailable === true;
            return (
              <div key={item.provider} className="surface surface--inset flex min-h-44 flex-col px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-display text-sm font-bold text-ink">{labels[item.provider]}</p>
                    <p className="mt-1 font-mono text-[0.68rem] text-ink-faint">{t(`peon.cliUpdates.${item.provider === "codex" ? "codexPackage" : "claudePackage"}`)}</p>
                  </div>
                  <Badge tone={failed ? "red" : available ? "amber" : active ? "neutral" : "green"}>
                    {failed ? t("peon.cliUpdates.failed") : active ? t("peon.cliUpdates.updating") : available ? t("peon.cliUpdates.available") : t("peon.cliUpdates.current")}
                  </Badge>
                </div>
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
                  <dt className="text-ink-faint">{t("peon.cliUpdates.installed")}</dt><dd className="text-right text-ink">{item.currentVersion ?? "—"}</dd>
                  <dt className="text-ink-faint">{t("peon.cliUpdates.latest")}</dt><dd className="text-right text-ink">{item.latestVersion ?? "—"}</dd>
                </dl>
                <div className="mt-auto pt-4">
                  {active ? (
                    <p role="status" aria-live="polite" className="flex items-center gap-2 font-mono text-xs text-accent-strong"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />{t("peon.cliUpdates.updatingDetail")}</p>
                  ) : (
                    <Button size="sm" onClick={() => void start(item.provider)} disabled={busy || starting !== null || !available}>{available ? t("peon.cliUpdates.install") : t("peon.cliUpdates.noUpdate")}</Button>
                  )}
                  {(item.error || failed) && <p className="mt-2 font-mono text-xs text-danger">⚠ {item.error ?? t("peon.cliUpdates.failed")}</p>}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <p className="font-mono text-xs text-ink-faint">{t("peon.cliUpdates.empty")}</p>}
        </div>
      )}
      {error && <p className="border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-xs text-danger">⚠ {error}</p>}
    </Card>
  );
}
