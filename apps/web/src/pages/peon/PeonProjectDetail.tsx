import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../api";
import { SessionSidebarList } from "../../components/SessionSidebarList";
import { useT } from "../../i18n";
import type { PresenceUser } from "../../liveSocket";
import { Card } from "../../ui";
import { usePeon } from "./context";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { ProjectTabs } from "./ProjectTabs";
import { type ProjectDetail } from "./peonApi";
import { ProjectDocumentation } from "./ProjectDocumentation";
import { ProjectQuickLinksCard } from "./ProjectQuickLinks";
import { mergeSessions, sessionFromIndex, type IndexedSessionLite, type SessionLite } from "./sessionList";
import { prefetchTranscriptSnapshot } from "./session/transcriptSnapshotCache";

// author: Viktor

const RECENT_PROJECT_SESSION_LIMIT = 8;

// The sidebar holds one page of the peon's sessions, so a project whose work is
// older than that page has none of its rows there. The card asks the index for
// its own project-scoped page and merges the sidebar's rows over it, which keeps
// live socket updates (status, attention) authoritative for the rows it does hold.
export function recentProjectSessions(
  sessions: SessionLite[],
  projectKey: string,
  limit = RECENT_PROJECT_SESSION_LIMIT,
  projectPage: SessionLite[] = [],
): SessionLite[] {
  return mergeSessions(projectPage, sessions)
    .filter((session) => session.projectKey === projectKey)
    .sort((left, right) => (right.lastActivityAt ?? right.startedAt ?? 0) - (left.lastActivityAt ?? left.startedAt ?? 0))
    .slice(0, Math.max(0, limit));
}

export function ProjectRecentSessions({
  projectKey,
  peonId,
  wsId,
  newSessionTo,
  sessions,
  loading,
  error,
  viewersFor,
  onRename,
  onDelete,
  base,
  paginationSupported,
}: {
  projectKey: string;
  peonId: string;
  wsId?: string;
  newSessionTo: string;
  sessions: SessionLite[];
  loading: boolean;
  error: boolean;
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
  onRename: (session: SessionLite, title: string | null) => Promise<void>;
  onDelete: (session: SessionLite) => Promise<void>;
  base?: string;
  paginationSupported?: boolean;
}) {
  const t = useT();
  const [projectPage, setProjectPage] = useState<SessionLite[] | null>(null);
  const [projectPageError, setProjectPageError] = useState(false);

  useEffect(() => {
    if (!wsId || !peonId || !projectKey) return;
    let alive = true;
    setProjectPage(null);
    setProjectPageError(false);
    api<{ sessions: IndexedSessionLite[] }>(
      `/workspaces/${encodeURIComponent(wsId)}/sessions?peonId=${encodeURIComponent(peonId)}`
      + `&projectKey=${encodeURIComponent(projectKey)}&limit=${RECENT_PROJECT_SESSION_LIMIT}`,
    )
      .then((result) => alive && setProjectPage((result.sessions ?? []).map(sessionFromIndex)))
      .catch(() => alive && setProjectPageError(true));
    return () => {
      alive = false;
    };
  }, [peonId, projectKey, wsId]);

  const recent = recentProjectSessions(sessions, projectKey, RECENT_PROJECT_SESSION_LIMIT, projectPage ?? []);
  const pending = loading || (wsId ? projectPage === null && !projectPageError : false);
  const failed = error && (wsId ? projectPageError : true);

  return (
    <Card className="overflow-hidden">
      <header className="flex min-h-12 items-center gap-3 border-b border-edge/90 bg-gradient-to-r from-warning/[0.06] via-transparent to-transparent px-5 py-2">
        <h2 className="min-w-0 flex-1 font-display text-sm font-bold tracking-wide text-ink">{t("peon.dash.recentSessions")}</h2>
        <span className="hidden md:inline-flex">
          <Link to={newSessionTo} className="btn btn-accent btn-sm h-7">{t("newSession.new")}</Link>
        </span>
      </header>

      <div>
        {recent.length > 0 ? (
          <SessionSidebarList
            sessions={recent}
            appearance="panel"
            to={(session) => `/peons/${encodeURIComponent(peonId)}/sessions/${encodeURIComponent(session.id)}`}
            peonIdFor={() => peonId}
            viewersFor={viewersFor}
            onNavigateIntent={base ? (session) => {
              void prefetchTranscriptSnapshot(base, session.id, paginationSupported ?? true).catch(() => {});
            } : undefined}
            onRename={onRename}
            onDelete={onDelete}
          />
        ) : pending ? (
          <div className="grid min-h-28 place-items-center">
            <span className="loading-spinner scale-75" role="status" aria-label={t("sessions.loading")} />
          </div>
        ) : failed ? (
          <p className="px-3 py-8 text-center font-mono text-xs text-danger">⚠ {t("error.loadFailed")}</p>
        ) : (
          <p className="px-3 py-8 text-center font-body text-xs text-ink-faint">{t("peon.dash.noSessions")}</p>
        )}
      </div>
      {recent.length > 0 && (
        <footer className="border-t border-edge/90 px-5 py-2.5 text-right font-mono text-xs tabular-nums text-ink-faint">
          {t("peon.projects.sessions", { n: recent.length })}
        </footer>
      )}
    </Card>
  );
}

export function PeonProjectDetail() {
  const t = useT();
  const peonContext = usePeon();
  const { peon, base } = peonContext;
  const sessions = peonContext.sessions ?? [];
  const sessionsLoading = peonContext.sessionsLoading ?? true;
  const sessionPageError = peonContext.sessionPageError ?? false;
  const viewersFor = peonContext.viewersFor ?? (() => []);
  const renameSession = peonContext.renameSession ?? (async () => {});
  const deleteSession = peonContext.deleteSession ?? (async () => {});
  const { key = "" } = useParams();
  const liveProject = peonContext.projects?.find((project) => project.key === key && !project.deleted);
  const newSessionTo = `/peons/${encodeURIComponent(peon.peonId)}/sessions/new?project=${encodeURIComponent(key)}`;

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailErr, setDetailErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setDetailErr(false);
    setDetail(null);
    api<ProjectDetail>(`${base}/projects/${encodeURIComponent(key)}`)
      .then((d) => alive && setDetail(d))
      .catch(() => alive && setDetailErr(true));
    return () => {
      alive = false;
    };
  }, [base, key]);

  return (
    <div className="space-y-3">
      <ProjectPageHeader showDesktopNewSession={false} />
      <ProjectTabs />

      {detail && <ProjectQuickLinksCard links={liveProject?.quickLinks ?? detail.quickLinks ?? []} cached={!peon.online} />}

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        {detail ? (
          <ProjectDocumentation base={base} projectId={detail.projectId ?? null} />
        ) : detailErr ? (
          <Card className="grid min-h-40 place-items-center px-6 py-8">
            <p className="font-mono text-xs text-danger">⚠ {t("error.loadFailed")}</p>
          </Card>
        ) : (
          <Card className="grid min-h-40 place-items-center">
            <span className="loading-spinner" role="status" aria-label={t("proj.docs.loading")} />
          </Card>
        )}
      <ProjectRecentSessions
          projectKey={key}
          peonId={peon.peonId}
          wsId={peonContext.wsId}
          newSessionTo={newSessionTo}
          sessions={sessions}
          loading={sessionsLoading}
          error={sessionPageError}
          viewersFor={viewersFor}
          onRename={renameSession}
        onDelete={deleteSession}
        base={base}
        paginationSupported={peon.capabilities.includes("transcript-pagination-v1")}
        />
      </div>
    </div>
  );
}
