import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { Badge, Card, StatPlate } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";

// author: Viktor

type Period = "day" | "yesterday" | "week" | "month";
const PERIODS: Period[] = ["day", "yesterday", "week", "month"];

// Peon /agent/v1/stats — flat SessionStats (peon sessions.ts). Every total is a
// top-level total* key; there is no `totals` wrapper. Rendered defensively so a
// missing field degrades to "—" rather than crashing.
interface Stats {
  period?: string;
  rangeStart?: number;
  rangeEnd?: number;
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
// Per-model usage rollup — attributed to the model actually used per turn, sorted
// by cost server-side. Rendered defensively (any field may be absent).
interface ByModel {
  model?: string;
  sessionCount?: number;
  totalTokens?: number;
  totalCostUsd?: number;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function fmtCount(n?: number): string {
  return typeof n === "number" ? compact.format(n) : "—";
}
function fmtCost(n?: number): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : "—";
}
function fmtDuration(ms?: number): string {
  if (typeof ms !== "number" || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function outcomeTone(outcome: string): "green" | "red" | "amber" | "neutral" {
  switch (outcome) {
    case "success":
      return "green";
    case "failure":
      return "red";
    case "needs_human":
      return "amber";
    case "running":
      return "green";
    default:
      return "neutral"; // "none" (finished, ungraded) and any unknown key
  }
}

export function PeonStats() {
  const t = useT();
  const { peon, base } = usePeon();
  const [period, setPeriod] = useState<Period>("day");
  const [stats, setStats] = useState<Stats | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [base, peon.online, period]);

  if (!peon.online) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;
  if (unsupported) return <p className="font-mono text-sm text-bone-faint">{t("peon.unsupported")}</p>;

  const outcomes = stats?.outcomeCounts ? Object.entries(stats.outcomeCounts) : [];
  const missingUsage = stats?.sessionsMissingUsage ?? 0;
  // Show the four token components (never their sum — totalTokens already folds in
  // the cache tokens, so summing would double-count).
  const breakdown: [string, number | undefined][] = [
    ["peon.stats.inputTokens", stats?.totalInputTokens],
    ["peon.stats.outputTokens", stats?.totalOutputTokens],
    ["peon.stats.cacheRead", stats?.totalCacheReadTokens],
    ["peon.stats.cacheWrite", stats?.totalCacheCreationTokens],
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
              period === p ? "border-fel text-fel-bright" : "border-iron-800 text-bone-dim hover:text-bone"
            }`}
          >
            {t(`peon.stats.period.${p}`)}
          </button>
        ))}
      </div>

      {error && <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>}
      {!stats && !error ? (
        <div className="forge-spin" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatPlate value={fmtCount(stats?.sessionCount)} label={t("peon.stats.sessions")} />
            <StatPlate value={fmtCount(stats?.totalTokens)} label={t("peon.stats.tokens")} tone="forge" />
            <StatPlate value={fmtCost(stats?.totalCostUsd)} label={t("peon.stats.cost")} tone="bone" />
            <StatPlate value={fmtDuration(stats?.totalDurationMs)} label={t("peon.stats.duration")} tone="bone" />
          </div>

          {missingUsage > 0 && <p className="font-mono text-xs text-bone-faint">{t("peon.stats.missingUsage", { n: missingUsage })}</p>}

          {hasBreakdown && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-bone-dim">
              {breakdown.map(([key, n]) => (
                <span key={key}>
                  <span className="text-bone-faint">{t(key)}</span> {fmtCount(n)}
                </span>
              ))}
            </div>
          )}

          {byModel.length > 0 && (
            <Card className="px-5 py-4">
              <div className="mb-3 font-display text-[0.6rem] uppercase tracking-[0.16em] text-bone-dim">{t("peon.stats.byModel")}</div>
              <ul className="space-y-2.5">
                {byModel.map((m, i) => (
                  <li key={m.model ?? i} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm text-bone">{m.model ?? "—"}</div>
                      <div className="font-mono text-xs text-bone-faint">
                        {t("peon.stats.byModel.sessions", { n: m.sessionCount ?? 0 })} · {fmtCount(m.totalTokens)} {t("peon.stats.tokens").toLowerCase()}
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-sm text-fel-bright">{fmtCost(m.totalCostUsd)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="px-5 py-4">
            <div className="mb-3 font-display text-[0.6rem] uppercase tracking-[0.16em] text-bone-dim">{t("peon.stats.outcomes")}</div>
            {outcomes.length === 0 ? (
              <p className="font-mono text-sm text-bone-faint">{t("peon.stats.empty")}</p>
            ) : (
              <ul className="space-y-2">
                {outcomes.map(([outcome, n]) => (
                  <li key={outcome} className="flex items-center justify-between gap-3">
                    <Badge tone={outcomeTone(outcome)}>{outcome.replace(/_/g, " ")}</Badge>
                    <span className="font-mono text-sm text-bone">{fmtCount(n)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
