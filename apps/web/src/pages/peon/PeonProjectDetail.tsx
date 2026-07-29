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
import type { SessionLite } from "./sessionList";

// author: Viktor

const RECENT_PROJECT_SESSION_LIMIT = 8;

export function recentProjectSessions(
  sessions: SessionLite[],
  projectKey: string,
  limit = RECENT_PROJECT_SESSION_LIMIT,
): SessionLite[] {
  return sessions
    .filter((session) => session.projectKey === projectKey)
    .sort((left, right) => (right.lastActivityAt ?? right.startedAt ?? 0) - (left.lastActivityAt ?? left.startedAt ?? 0))
    .slice(0, Math.max(0, limit));
}

export function ProjectRecentSessions({
  projectKey,
  peonId,
  newSessionTo,
  sessions,
  loading,
  error,
  viewersFor,
  onRename,
  onDelete,
}: {
  projectKey: string;
  peonId: string;
  newSessionTo: string;
  sessions: SessionLite[];
  loading: boolean;
  error: boolean;
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
  onRename: (session: SessionLite, title: string | null) => Promise<void>;
  onDelete: (session: SessionLite) => Promise<void>;
}) {
  const t = useT();
  const recent = recentProjectSessions(sessions, projectKey);

  return (
    <Card className="overflow-hidden">
      <header className="flex min-h-12 items-center gap-3 border-b border-iron-800/90 bg-gradient-to-r from-forge/[0.06] via-transparent to-transparent px-5 py-2">
        <h2 className="min-w-0 flex-1 font-display text-sm font-bold tracking-wide text-bone">{t("peon.dash.recentSessions")}</h2>
        <span className="hidden md:inline-flex">
          <Link to={newSessionTo} className="btn btn-fel btn-sm h-7">{t("newSession.new")}</Link>
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
            onRename={onRename}
            onDelete={onDelete}
          />
        ) : loading ? (
          <div className="grid min-h-28 place-items-center">
            <span className="forge-spin scale-75" role="status" aria-label={t("sessions.loading")} />
          </div>
        ) : error ? (
          <p className="px-3 py-8 text-center font-mono text-xs text-blood">⚠ {t("error.loadFailed")}</p>
        ) : (
          <p className="px-3 py-8 text-center font-body text-xs text-bone-faint">{t("peon.dash.noSessions")}</p>
        )}
      </div>
      {recent.length > 0 && (
        <footer className="border-t border-iron-800/90 px-5 py-2.5 text-right font-mono text-xs tabular-nums text-bone-faint">
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
            <p className="font-mono text-xs text-blood">⚠ {t("error.loadFailed")}</p>
          </Card>
        ) : (
          <Card className="grid min-h-40 place-items-center">
            <span className="forge-spin" role="status" aria-label={t("proj.docs.loading")} />
          </Card>
        )}
        <ProjectRecentSessions
          projectKey={key}
          peonId={peon.peonId}
          newSessionTo={newSessionTo}
          sessions={sessions}
          loading={sessionsLoading}
          error={sessionPageError}
          viewersFor={viewersFor}
          onRename={renameSession}
          onDelete={deleteSession}
        />
      </div>
    </div>
  );
}
