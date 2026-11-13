import { Card, CARD_HEADER_CLASS, CARD_TITLE_CLASS } from "../../shared/ui";
import { useViewportFill } from "../../shared/viewportFill";
import { useSessionPins, orderPinnedSessions } from "../sessions/useSessionPins";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "../../shared/api";
import { Link, useParams } from "react-router";
import { useApiResource } from "../../shared/useApiResource";
import { SessionSidebarList } from "../sessions/SessionSidebarList";
import { useT } from "../../shared/i18n";
import type { PresenceUser } from "../../realtime/liveSocket";
import { usePeon } from "../fleet/context";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { ProjectTabs } from "./ProjectTabs";
import { type ProjectDetail } from "../fleet/peonApi";
import { ProjectDocumentation } from "./ProjectDocumentation";
import { ProjectQuickLinksCard } from "./ProjectQuickLinks";
import { mergeSessions, sessionFromIndex, type IndexedSessionLite, type SessionLite } from "../sessions/sessionList";
import { prefetchTranscriptSnapshot } from "../sessions/transcriptSnapshotCache";

// author: Viktor

const PROJECT_SESSION_PAGE_SIZE = 50;

// The sidebar holds one page of the peon's sessions, so a project whose work is
// older than that page has none of its rows there. The panel pages through the
// index for its own project and merges the sidebar's rows over it, which keeps
// live socket updates (status, attention) authoritative for the rows it does hold.
// While more pages remain, sidebar rows older than the last fetched row are held
// back so they cannot jump ahead of sessions not yet loaded.
export function recentProjectSessions(
  sessions: SessionLite[],
  projectKey: string,
  limit = Number.POSITIVE_INFINITY,
  projectPage: SessionLite[] = [],
  hasMore = false,
): SessionLite[] {
  const activity = (session: SessionLite) => session.lastActivityAt ?? session.startedAt ?? 0;
  const oldestFetched = hasMore && projectPage.length > 0 ? Math.min(...projectPage.map(activity)) : Number.NEGATIVE_INFINITY;
  return mergeSessions(projectPage, sessions)
    .filter((session) => session.projectKey === projectKey && activity(session) >= oldestFetched)
    .sort((left, right) => activity(right) - activity(left))
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
  const [projectTotal, setProjectTotal] = useState<number | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [projectPageError, setProjectPageError] = useState(false);
  const loadEpoch = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadPage = useCallback((offset: number) => {
    if (!wsId || !peonId || !projectKey) return;
    const epoch = loadEpoch.current;
    setPageLoading(true);
    setProjectPageError(false);
    api<{ sessions: IndexedSessionLite[]; total?: number }>(
      `/workspaces/${encodeURIComponent(wsId)}/sessions?peonId=${encodeURIComponent(peonId)}`
        + `&projectKey=${encodeURIComponent(projectKey)}&limit=${PROJECT_SESSION_PAGE_SIZE}&offset=${offset}`,
    ).then((data) => {
      if (epoch !== loadEpoch.current) return;
      const rows = (data.sessions ?? []).map(sessionFromIndex);
      setProjectPage((current) => offset === 0 ? rows : mergeSessions(current ?? [], rows));
      setProjectTotal(data.total ?? null);
    }).catch(() => {
      if (epoch === loadEpoch.current) setProjectPageError(true);
    }).finally(() => {
      if (epoch === loadEpoch.current) setPageLoading(false);
    });
  }, [peonId, projectKey, wsId]);

  useEffect(() => {
    loadEpoch.current += 1;
    setProjectPage(null);
    setProjectTotal(null);
    loadPage(0);
  }, [loadPage]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const fetchedCount = projectPage?.length ?? 0;
  const hasMore = projectTotal !== null && fetchedCount < projectTotal;

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !hasMore || pageLoading || projectPageError) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadPage(fetchedCount);
    // The list scrolls inside its card on wide screens; elsewhere the page does.
    }, { root: scroller.current && scroller.current.scrollHeight > scroller.current.clientHeight ? scroller.current : null, rootMargin: "400px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchedCount, hasMore, loadPage, pageLoading, projectPageError]);

  const sessionPins = useSessionPins(wsId, peonId);
  const recent = orderPinnedSessions(recentProjectSessions(sessions, projectKey, undefined, projectPage ?? [], hasMore), sessionPins.pins.filter((session) => session.projectKey === projectKey), peonId);
  const pending = loading || (wsId ? projectPage === null && !projectPageError : false);
  const failed = error && (wsId ? projectPageError : true);

  return (
    <Card className="flex min-w-0 flex-col overflow-hidden lg:h-full">
      <header className={CARD_HEADER_CLASS}>
        <h2 className={CARD_TITLE_CLASS}>{t("peon.dash.recentSessions")}</h2>
        <span className="hidden md:inline-flex">
          <Link to={newSessionTo} className="flex items-center gap-1 font-body text-xs font-bold text-accent-strong transition-opacity hover:opacity-75">
            {t("sidebar.newSession")}
            <Plus size={15} aria-hidden />
          </Link>
        </span>
      </header>

      <div ref={scroller} className="min-h-0 lg:flex-1 lg:overflow-y-auto">
        {recent.length > 0 ? (
          <SessionSidebarList
            onPin={sessionPins.toggle}
            isPinned={sessionPins.isPinned}
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
      {hasMore && (
        <div ref={sentinel} className="flex min-h-10 items-center justify-center" aria-live="polite">
          {pageLoading && <span className="loading-spinner scale-75" role="status" aria-label={t("sessions.loading")} />}
          {projectPageError && (
            <button type="button" className="font-body text-[0.68rem] text-ink-muted hover:text-accent-strong" onClick={() => loadPage(fetchedCount)}>
              {t("sessions.retry")}
            </button>
          )}
        </div>
      )}
      </div>
      {recent.length > 0 && (
        <footer className="border-t border-edge px-4 py-2.5 sm:px-5 text-right font-mono text-xs tabular-nums text-ink-faint">
          {t("peon.projects.sessions", { n: Math.max(recent.length, projectTotal ?? 0) })}
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

  // On wide screens the two columns end where the viewport ends and scroll
  // independently: sessions inside their card, links and docs in theirs.
  const pane = useViewportFill({ minHeight: 448 });
  const { data: detail, error: detailError } = useApiResource<ProjectDetail>(`${base}/projects/${encodeURIComponent(key)}`);
  const detailErr = Boolean(detailError);

  return (
    <div>
      <ProjectPageHeader showDesktopNewSession={false} />
      <ProjectTabs />

      {/* Glass panels like every other page: sessions on the left, quick links
          and the project's documentation on the right. */}
      <div ref={pane.ref} style={{ height: pane.height }} className="mt-1 grid items-start gap-3 lg:grid-cols-[minmax(20rem,2fr)_minmax(0,3fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch">
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
        <div className="flex min-w-0 flex-col gap-3 lg:min-h-0">
          {detail && <ProjectQuickLinksCard links={liveProject?.quickLinks ?? detail.quickLinks ?? []} cached={!peon.online} />}
          <Card className="min-w-0 overflow-hidden lg:min-h-0 lg:flex-1">
          {detail ? (
            <ProjectDocumentation base={base} projectId={detail.projectId ?? null} fill />
          ) : detailErr ? (
            <div className="grid min-h-40 place-items-center px-6 py-8">
              <p className="font-mono text-xs text-danger">⚠ {t("error.loadFailed")}</p>
            </div>
          ) : (
            <div className="grid min-h-40 place-items-center">
              <span className="loading-spinner" role="status" aria-label={t("proj.docs.loading")} />
            </div>
          )}
          </Card>
        </div>
      </div>
    </div>
  );
}
