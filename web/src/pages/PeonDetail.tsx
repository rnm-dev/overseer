import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useWorkspace } from "../workspace";
import { useT } from "../i18n";
import type { PeonContext, PeonView } from "./peon/context";

// author: Viktor

const TABS = [
  { to: "", key: "peon.tab.dashboard", end: true },
  { to: "sessions", key: "peon.tab.sessions", end: false },
  { to: "projects", key: "peon.tab.projects", end: false },
  { to: "stats", key: "peon.tab.stats", end: false },
  { to: "settings", key: "peon.tab.settings", end: false },
] as const;

export function PeonDetail() {
  const t = useT();
  const { peonId = "" } = useParams();
  const { current, setCurrent, workspaceIdOfPeon } = useWorkspace();
  const wsOfPeon = workspaceIdOfPeon(peonId);
  const wsId = wsOfPeon ?? current?.id;
  const base = `/workspaces/${wsId}/peons/${peonId}`;

  // Landing on a peon (deep-link/refresh) may have a different workspace selected;
  // sync `current` to this peon's workspace so the live tail + scoped calls match.
  useEffect(() => {
    if (wsOfPeon && wsOfPeon !== current?.id) setCurrent(wsOfPeon);
  }, [wsOfPeon, current?.id, setCurrent]);

  const [peon, setPeon] = useState<PeonView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!wsId) return;
    api<PeonView>(base)
      .then((p) => {
        setPeon(p);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? t("peon.notFound") : err instanceof Error ? err.message : t("error.loadFailed")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, wsId]);

  useEffect(() => {
    reload();
    const timer = window.setInterval(reload, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  if (error) {
    return (
      <div className="reveal">
        <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>
      </div>
    );
  }
  if (!peon) return <div className="forge-spin" />;

  const ctx: PeonContext = { peon, wsId: wsId!, base, reload };

  return (
    <div className="reveal">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-iron-800">
        <h1 className="pb-3 font-display text-2xl font-extrabold tracking-wide text-bone">{peon.name || t("peons.unnamed")}</h1>
        <nav className="flex flex-wrap gap-1">
          {TABS.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `-mb-px border-b-2 px-3 py-2 font-display text-[0.7rem] font-bold uppercase tracking-[0.12em] transition-colors ${
                  isActive ? "border-fel text-fel-bright" : "border-transparent text-bone-dim hover:text-bone"
                }`
              }
            >
              {t(tab.key)}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet context={ctx} />
    </div>
  );
}
