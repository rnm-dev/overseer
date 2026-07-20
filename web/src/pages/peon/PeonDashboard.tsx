import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { Badge, Card, titleize } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { useLiveSocket } from "../../liveSocket";
import { SessionPresence } from "../../components/SessionPresence";
import { sessionDisplayTitle } from "./sessionList";
import { peonOverviewNewSessionPath, peonOverviewProjectsPath, peonOverviewSessionsPath } from "./overviewNavigation";

// author: Viktor

type AuthState = "ok" | "unauthenticated" | "broken" | "unknown";

interface LiveStatus {
  agentAuth?: { authState?: AuthState; available?: boolean; checkedAt?: number } | null;
}
interface Session {
  id: string;
  status?: string | null;
  title?: string | null;
  promptPreview?: string | null;
  prompt?: string | null;
  projectKey?: string | null;
  dir?: string | null;
  lastMessagePreview?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
}
interface Project {
  key: string;
  path?: string | null;
  sessionCount?: number;
  activeCount?: number;
}

function ago(ms?: number | null): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function statusTone(status?: string | null): "green" | "amber" | "red" | "neutral" {
  return status === "running" ? "green" : status === "needs_human" ? "amber" : status === "failure" || status === "failed" || status === "error" ? "red" : "neutral";
}

export function PeonDashboard() {
  const t = useT();
  const { peon, base } = usePeon();
  const { viewersFor } = useLiveSocket();
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    if (!peon.online) return;
    let alive = true;
    const pull = () => {
      api<LiveStatus>(`${base}/status`).then((s) => alive && setStatus(s)).catch(() => {});
      api<{ sessions: Session[] }>(`${base}/sessions`).then((r) => alive && setSessions(r.sessions ?? [])).catch(() => alive && setSessions([]));
      api<{ projects: Project[] }>(`${base}/projects`).then((r) => alive && setProjects(r.projects ?? [])).catch(() => alive && setProjects([]));
    };
    pull();
    const timer = window.setInterval(pull, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [base, peon.online]);

  if (!peon.online) {
    return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;
  }

  // Older peons don't report agentAuth — only warn when a bad state is present.
  const authState = status?.agentAuth?.authState;
  const authBad = authState === "broken" || authState === "unauthenticated";

  const recent = [...(sessions ?? [])].sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0)).slice(0, 5);
  const topProjects = [...(projects ?? [])].slice(0, 5);

  return (
    <div className="space-y-6">
      {authBad && (
        <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">
          ⚠ {authState === "unauthenticated" ? t("peon.auth.warnUnauth") : t("peon.auth.warnBroken")}
        </p>
      )}

      {/* Recent sessions */}
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-display text-[0.6rem] uppercase tracking-[0.16em] text-bone-dim">{t("peon.dash.recentSessions")}</h3>
          <Link to={peonOverviewNewSessionPath(peon.peonId)} className="btn btn-sm">
            {t("newSession.new")}
          </Link>
        </div>
        <Card>
          {sessions === null ? (
            <div className="p-6"><div className="forge-spin" /></div>
          ) : recent.length === 0 ? (
            <p className="p-6 text-center font-mono text-sm text-bone-faint">{t("peon.dash.noSessions")}</p>
          ) : (
            <ul className="divide-y divide-iron-800">
              {recent.map((s) => (
                <li key={s.id}>
                  <Link to={peonOverviewSessionsPath(peon.peonId, s.id)} className="flex items-start justify-between gap-3 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {s.projectKey && (
                          <span className="flex-none font-display text-sm font-medium text-forge" title={t("session.project")}>
                            {titleize(s.projectKey)}
                          </span>
                        )}
                        <div className="truncate font-display text-sm font-medium text-bone">{sessionDisplayTitle(s, t("session.untitled"))}</div>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-bone-faint">{s.lastMessagePreview || s.dir || "—"}</div>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1">
                      <SessionPresence viewers={viewersFor(peon.peonId, s.id)} />
                      {ago(s.lastActivityAt ?? s.startedAt) && <span className="font-mono text-[0.7rem] text-bone-dim">{ago(s.lastActivityAt ?? s.startedAt)}</span>}
                      {s.status && s.status !== "completed" && <Badge tone={statusTone(s.status)}>{s.status.replace(/_/g, " ")}</Badge>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Projects */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-[0.6rem] uppercase tracking-[0.16em] text-bone-dim">{t("peon.dash.projects")}</h3>
          <Link to={peonOverviewProjectsPath(peon.peonId)} className="font-mono text-xs text-bone-dim transition-colors hover:text-fel-bright">
            {t("peon.dash.viewAll")}
          </Link>
        </div>
        <Card>
          {projects === null ? (
            <div className="p-6"><div className="forge-spin" /></div>
          ) : topProjects.length === 0 ? (
            <p className="p-6 text-center font-mono text-sm text-bone-faint">{t("peon.projects.empty")}</p>
          ) : (
            <ul className="divide-y divide-iron-800">
              {topProjects.map((p) => (
                <li key={p.key}>
                  <Link to={peonOverviewProjectsPath(peon.peonId, p.key)} className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                    <div className="min-w-0">
                      <div className="truncate font-display text-sm font-medium text-bone">{p.key}</div>
                      {p.path && <div className="mt-0.5 truncate font-mono text-xs text-bone-faint">{p.path}</div>}
                    </div>
                    <div className="flex flex-none items-center gap-3 font-mono text-[0.7rem] text-bone-dim">
                      {(p.activeCount ?? 0) > 0 && <span className="text-forge">{t("peon.projects.active", { n: p.activeCount ?? 0 })}</span>}
                      <span>{t("peon.projects.sessions", { n: p.sessionCount ?? 0 })}</span>
                      <span className="text-fel-bright" aria-hidden>›</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
