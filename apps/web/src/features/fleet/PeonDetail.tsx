import { useSessionPins, orderPinnedSessions } from "../sessions/useSessionPins";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BarChart3, ClipboardCheck, FolderGit2, MessagesSquare, Plus, Menu, Settings, type LucideIcon } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../../shared/api";
import { useWorkspace } from "../workspaces/workspace";
import { usePeonPresence } from "./usePeonPresence";
import { useMobileDrawer } from "../../shared/useMobileDrawer";
import { useT } from "../../shared/i18n";
import { TOOLBAR_GROUP, toolbarItemClass } from "../../shared/ui";
import { usePresence, useLiveSocket, type SessionLiveEvent } from "../../realtime/liveSocket";
import { PeonScopeSwitcher } from "../workspaces/PeonScopeSwitcher";
import { ProjectGroupedSessionList } from "../sessions/ProjectGroupedSessionList";
import { FadingTitle, SessionSidebarList } from "../sessions/SessionSidebarList";
import {
  loadSessionListDisplayMode,
  loadSessionListProjectLimit,
  saveSessionListDisplayMode,
} from "../sessions/SessionListDisplayControl";
import { PeonConnectionStatusDot } from "./PeonConnectionStatusDot";
import type { PeonContext, PeonView } from "./context";
import { NewProjectDialog } from "../projects/NewProjectDialog";
import { applyProjectEvent, applyProjectSessionCounts, mergeProjects, withLiveActiveSessionCounts, type ProjectLite } from "../projects/projectList";
import { applyAttentionEvent, applyLocalSessionRunningChange, applySessionEvent, mergeSessions, sessionFromIndex, sessionSidebarCanLoad, type IndexedSessionEvent, type IndexedSessionLite, type SessionLite } from "../sessions/sessionList";
import { MobilePaneIdentity } from "../sessions/mobileHeader";
import { nextSessionAfterDeletion } from "../sessions/nextSession";
import { prefetchTranscriptSnapshot } from "../sessions/transcriptSnapshotCache";
import { isProjectPath, sessionListRequestPath } from "./peonApi";
import { useResizableSidebar } from "./useResizableSidebar";
import { useWorkingTitle } from "./useWorkingTitle";
import { sessionRouteShellClass } from "../sessions/sessionViewport";
import { SignoffSidebarList } from "../signoffs/SignoffSidebarList";
import { useWorkspaceSignoffs } from "../signoffs/signoffApi";

// author: Viktor

type PeonNavItem = {
  to: string;
  key: "peon.tab.stats";
  icon: LucideIcon;
};

// Work is the Peon landing view. Projects live in the sidebar, leaving the
// compact icon rail for Work, Stats, and Settings.
export const PEON_NAV_ITEMS: readonly PeonNavItem[] = [
  { to: "stats", key: "peon.tab.stats", icon: BarChart3 },
];

const iconNavClass = (active: boolean) => toolbarItemClass(active, true);
const newButtonClass = (active: boolean) => `inline-flex items-center gap-1 rounded px-1.5 py-1 font-body text-[0.6875rem] transition-colors ${active ? "bg-accent/10 text-accent-strong" : "text-ink-muted hover-wash hover:text-accent-strong"}`;

export function PeonDetail() {
  const t = useT();
  const { peonId = "", sid = "", key: projectKey = "" } = useParams();
  const { subscribeAttention, subscribeMentionAttention, subscribeProjects, subscribeSessions } = useLiveSocket();
  const { viewersFor } = usePresence();
  const location = useLocation();
  const navigate = useNavigate();
  const { current, workspaces, setCurrent, workspaceIdOfPeon } = useWorkspace();
  const wsOfPeon = workspaceIdOfPeon(peonId);
  const wsId = wsOfPeon ?? current?.id;
  const sessionPins = useSessionPins(wsId, peonId);
  const base = `/workspaces/${wsId}/peons/${peonId}`;
  const workspaceSignoffs = useWorkspaceSignoffs(wsId, "all");
  const signoffsAwaiting = workspaceSignoffs.signoffs?.filter((row) => row.awaitingViewer).length ?? 0;
  // Sessions with something unread for me — a finished turn I started or a
  // mention of me. Recounted on every attention change, coalesced.
  const [unreadSessions, setUnreadSessions] = useState(0);
  useEffect(() => {
    if (!wsId || !peonId) return;
    let alive = true;
    let pending: number | null = null;
    const load = () => {
      void api<{ count: number }>(`${base}/unread-sessions`)
        .then((body) => alive && setUnreadSessions(body.count))
        .catch(() => undefined);
    };
    const soon = () => {
      if (pending !== null) window.clearTimeout(pending);
      pending = window.setTimeout(load, 400);
    };
    load();
    const timer = window.setInterval(load, 60_000);
    const offAttention = subscribeAttention(soon);
    const offMentions = subscribeMentionAttention(soon);
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (pending !== null) window.clearTimeout(pending);
      offAttention();
      offMentions();
    };
  }, [base, peonId, subscribeAttention, subscribeMentionAttention, wsId]);
  const isOwner = workspaces.find((workspace) => workspace.id === wsId)?.role === "owner";

  // Landing on a peon (deep-link/refresh) may have a different workspace selected;
  // sync `current` to this peon's workspace so the live tail + scoped calls match.
  useEffect(() => {
    if (wsOfPeon && wsOfPeon !== current?.id) setCurrent(wsOfPeon);
  }, [wsOfPeon, current?.id, setCurrent]);

  const [peon, setPeon] = useState<PeonView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionPageError, setSessionPageError] = useState(false);
  const [projects, setProjects] = useState<ProjectLite[] | null>(null);
  const [projectError, setProjectError] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [sessionListMode, setSessionListMode] = useState(loadSessionListDisplayMode);
  // Sign-offs are a third sidebar tab, workspace-wide; opening one keeps it selected.
  const [signoffTab, setSignoffTab] = useState(() => location.pathname.includes("/signoffs/"));
  // Stats and Settings take the main pane; the list icons are not "current" there.
  const onPeonPage = /\/(stats|settings)(\/|$)/.test(location.pathname);
  const [sessionsPerProject] = useState(loadSessionListProjectLimit);
  const { drawerOpen, setDrawerOpen } = useMobileDrawer();
  const sidebar = useResizableSidebar();
  const sessionScrollNode = useRef<HTMLDivElement>(null);
  const sessionLoadSentinel = useRef<HTMLDivElement>(null);
  const sessionLoadEpoch = useRef(0);
  const sessionLoading = useRef(false);
  const nextSessionOffset = useRef(0);
  const { online } = usePeonPresence(peonId, wsId);
  const onSessionRunningChange = useCallback((changedPeonId: string, sessionId: string, running: boolean, changedAt: number) => {
    setSessions((current) => applyLocalSessionRunningChange(current, changedPeonId, sessionId, running, changedAt));
  }, []);

  // Route changes select an item from the mobile drawer. Start its exit motion
  // as soon as the newly selected page becomes active.
  useEffect(() => setDrawerOpen(false), [location.pathname, setDrawerOpen]);

  const reload = useCallback(() => {
    if (!wsId) return;
    api<PeonView>(base)
      .then((p) => {
        // HTTP supplies metadata only; connectivity comes exclusively from the
        // workspace socket projection below.
        setPeon({ ...p, online: false });
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 404 ? t("peon.notFound") : err instanceof Error ? err.message : t("error.loadFailed")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, wsId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadProjects = useCallback(async () => {
    if (!wsId) return;
    try {
      const result = await api<{ projects: ProjectLite[] }>(`${base}/projects`);
      const incoming = (result.projects ?? []).map((project) => ({ ...project, peonId: project.peonId ?? peonId }));
      setProjects((current) => mergeProjects(current ?? [], incoming));
      setProjectError(false);
    } catch {
      setProjectError(true);
    }
  }, [base, peonId, wsId]);

  useEffect(() => {
    setProjects(null);
    setProjectError(false);
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => subscribeProjects((event) => {
    if (event.peonId !== peonId) return;
    setProjects((current) => applyProjectEvent(current ?? [], event));
    setProjectError(false);
  }), [peonId, subscribeProjects]);

  const loadNextSessions = useCallback(async () => {
    if (!sessionSidebarCanLoad(wsId) || sessionLoading.current) return;
    const epoch = sessionLoadEpoch.current;
    const offset = nextSessionOffset.current;
    sessionLoading.current = true;
    setSessionsLoading(true);
    setSessionPageError(false);
    try {
      const grouped = sessionListMode === "grouped";
      const result = await api<{ sessions: IndexedSessionLite[]; total: number }>(
        sessionListRequestPath(wsId!, peonId, sessionListMode, sessionsPerProject, offset),
      );
      if (sessionLoadEpoch.current !== epoch) return;
      const page = (result.sessions ?? []).map(sessionFromIndex);
      const nextOffset = grouped ? page.length : offset + page.length;
      nextSessionOffset.current = page.length === 0 ? result.total : nextOffset;
      setSessionOffset(nextSessionOffset.current);
      setSessionTotal(result.total);
      setSessions((current) => mergeSessions(current, page));
    } catch {
      if (sessionLoadEpoch.current === epoch) setSessionPageError(true);
    } finally {
      if (sessionLoadEpoch.current === epoch) {
        sessionLoading.current = false;
        setSessionsLoading(false);
      }
    }
  }, [peonId, sessionListMode, sessionsPerProject, wsId]);

  // Sessions for the sidebar come from Overseer's local paginated index. The
  // index is continuously reconciled with Peon, avoiding a full-list transfer
  // through both Peon and Overseer whenever the sidebar refreshes.
  useEffect(() => {
    sessionLoadEpoch.current += 1;
    sessionLoading.current = false;
    nextSessionOffset.current = 0;
    setSessions([]);
    setSessionTotal(null);
    setSessionOffset(0);
    setSessionsLoading(false);
    setSessionPageError(false);
    if (!sessionSidebarCanLoad(wsId)) return;
    void loadNextSessions();
    return () => {
      sessionLoadEpoch.current += 1;
      sessionLoading.current = false;
    };
  }, [loadNextSessions, wsId]);

  const hasMoreSessions = sessionTotal !== null && sessionOffset < sessionTotal;
  useEffect(() => {
    const root = sessionScrollNode.current;
    const target = sessionLoadSentinel.current;
    if (sessionListMode !== "flat" || !root || !target || !hasMoreSessions || sessionsLoading || sessionPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNextSessions();
      },
      { root, rootMargin: "0px 0px 160px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMoreSessions, loadNextSessions, sessionListMode, sessionPageError, sessionsLoading]);

  // Session summaries arrive over the resumable workspace socket after the
  // initial indexed page is hydrated.
  useEffect(() => subscribeSessions((event: SessionLiveEvent) => {
    if (event.peonId !== peonId || typeof event.sessionId !== "string" || !event.sessionId) return;
    // Keep the Peon-qualified identity used by indexed HTTP summaries. Omitting
    // peonId here made a freshly pushed session use the unscoped `sessionId`
    // key; the next index refresh then treated the same record as a second row
    // under `peonId + sessionId` until a page reload cleared local state.
    setSessions((current) => applySessionEvent(current, event as IndexedSessionEvent));
    setProjects((current) => current ? applyProjectSessionCounts(current, event.projectSessionCounts) : current);
    if (event.deleted) setSessionTotal((total) => total === null ? null : Math.max(0, total - 1));
  }), [peonId, subscribeSessions]);

  useEffect(() => subscribeAttention((event) => {
    if (event.peonId !== peonId) return;
    setSessions((current) => applyAttentionEvent(current, event));
  }), [peonId, subscribeAttention]);

  useWorkingTitle(peon, sessions, sid);

  const activeProject = sessions.find((s) => s.id === sid)?.projectKey;
  const newSessionTo = activeProject ? `sessions/new?project=${encodeURIComponent(activeProject)}` : "sessions/new";
  const projectPageActive = isProjectPath(location.pathname);

  // Same ordering as the session list page: newest activity first.
  const ordered = useMemo(() => orderPinnedSessions(sessions, sessionPins.pins, peonId), [sessions, sessionPins.pins, peonId]);
  // Project rollups refresh independently and can lag a live session event.
  // Once the sidebar session projection is hydrated, use that same projection
  // as the immediate source for project activity lights.
  const sidebarProjects = useMemo(
    () => projects && sessionTotal !== null ? withLiveActiveSessionCounts(projects, sessions) : projects,
    [projects, sessionTotal, sessions],
  );

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-7">
        <Link to="/" className="font-body text-xs text-ink-muted hover:text-accent-strong">
          {t("peon.back")}
        </Link>
        <p className="mt-4 border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {error}</p>
      </div>
    );
  }
  if (!peon) return <div className="grid min-h-screen place-items-center"><div className="loading-spinner" /></div>;

  const displayedPeon = { ...peon, online };
  const onSessionDeleted = (_deletedPeonId: string, sessionId: string) => {
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setSessionTotal((total) => total === null ? null : Math.max(0, total - 1));
    nextSessionOffset.current = Math.max(0, nextSessionOffset.current - 1);
    setSessionOffset(nextSessionOffset.current);
  };
  const renameSession = async (session: SessionLite, title: string | null) => {
    await api(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, title } : item));
  };
  const deleteSession = async (session: SessionLite) => {
    const nextSessionId = nextSessionAfterDeletion(ordered.map((item) => item.id), session.id);
    await api(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    onSessionDeleted(peonId, session.id);
    if (sid === session.id) {
      navigate(
        nextSessionId
          ? `/peons/${encodeURIComponent(peonId)}/sessions/${encodeURIComponent(nextSessionId)}`
          : `/peons/${encodeURIComponent(peonId)}`,
        { replace: true },
      );
    }
  };
  const prefetchSession = (session: SessionLite) => {
    void prefetchTranscriptSnapshot(
      base,
      session.id,
      peon.capabilities.includes("transcript-pagination-v1"),
    ).catch(() => {});
  };

  const ctx: PeonContext = {
    peon: displayedPeon,
    wsId: wsId!,
    base,
    reload,
    isOwner,
    orderedSessionIds: ordered.map((session) => session.id),
    sessions: ordered,
    projects: sidebarProjects ?? [],
    sessionsLoading,
    sessionPageError,
    viewersFor,
    renameSession,
    deleteSession,
    selectedSession: sessions.find((session) => session.id === sid),
    onSessionDeleted,
    onSessionRunningChange,
  };
  return (
    <div className={`flex ${sessionRouteShellClass(Boolean(sid))}`}>
      <button
        type="button"
        aria-label={t("a11y.close")}
        aria-hidden={!drawerOpen}
        disabled={!drawerOpen}
        tabIndex={-1}
        data-open={drawerOpen}
        className="mobile-drawer-backdrop fixed inset-0 z-[45] md:hidden"
        onClick={() => setDrawerOpen(false)}
      />
      <aside
        id="peon-navigation"
        data-open={drawerOpen}
        className="mobile-drawer-panel fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(20rem,86vw)] shrink-0 flex-col border-r border-edge bg-surface shadow-2xl md:visible md:sticky md:top-1 md:z-auto md:my-1 md:mx-1 md:h-[calc(100vh-0.5rem)] md:w-[var(--peon-sidebar-width)] md:translate-x-0 md:overflow-hidden glass-panel-md"
      >
        {/* header: back + workspace-wide Peon scope switcher */}
        <div className="border-b border-edge/60 px-2 py-2">
          <div className="flex items-center gap-1">
            <Link
              to="/"
              title={t("peon.back")}
              aria-label={t("peon.back")}
              className="flex-none rounded p-1.5 text-ink-muted transition-colors hover-wash hover:text-accent-strong"
            >
              <ArrowLeft size={16} />
            </Link>
            <PeonScopeSwitcher workspaceId={wsId!} peonId={peonId} />
            <div className={TOOLBAR_GROUP}>
              {([
                { view: "flat", key: "peon.tab.sessions", icon: MessagesSquare },
                { view: "grouped", key: "sidebar.tab.projects", icon: FolderGit2 },
                { view: "signoffs", key: "signoffs.tab", icon: ClipboardCheck },
              ] as const).map(({ view, key, icon: Icon }) => {
                // The sidebar list follows these; on Stats or Settings they also
                // bring the main pane back to sessions.
                const selected = view === "signoffs" ? signoffTab : !signoffTab && sessionListMode === view;
                const awaiting = view === "signoffs" ? signoffsAwaiting : view === "flat" ? unreadSessions : 0;
                return (
                  <button
                    key={view}
                    type="button"
                    title={t(key)}
                    aria-label={awaiting > 0 ? `${t(key)} — ${t(view === "signoffs" ? "signoffs.awaitingCount" : "sessions.unreadCount", { count: awaiting })}` : t(key)}
                    aria-pressed={selected}
                    className={`relative ${iconNavClass(selected && !onPeonPage)}`}
                    onClick={() => {
                      if (view === "signoffs") setSignoffTab(true);
                      else {
                        setSignoffTab(false);
                        setSessionListMode(view);
                        saveSessionListDisplayMode(view);
                      }
                      if (onPeonPage) navigate("sessions");
                    }}
                  >
                    <Icon size={16} />
                    {awaiting > 0 && (
                      <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-accent px-0.5 text-center font-body text-[0.5625rem] font-semibold leading-[0.875rem] text-on-accent">
                        {awaiting > 9 ? "9+" : awaiting}
                      </span>
                    )}
                  </button>
                );
              })}
              {PEON_NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={t(item.key)}
                    aria-label={t(item.key)}
                    className={({ isActive }) => iconNavClass(isActive)}
                  >
                    <Icon size={16} />
                  </NavLink>
                );
              })}
              {isOwner && <NavLink
                to="settings"
                title={t("peon.tab.settings")}
                aria-label={t("peon.tab.settings")}
                className={({ isActive }) => iconNavClass(isActive)}
              >
                <Settings size={16} />
              </NavLink>}
            </div>
          </div>
        </div>

        {/* The selected view's title, with its create action on the right. */}
        <div className="flex h-9 items-center gap-2 pl-3 pr-1.5">
          <h2 className="min-w-0 flex-1 truncate font-display text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-ink">
            {t(signoffTab ? "signoffs.tab" : sessionListMode === "flat" ? "peon.tab.sessions" : "sidebar.tab.projects")}
          </h2>
          {signoffTab ? null : sessionListMode === "flat" ? (
            <NavLink
              to={newSessionTo}
              end
              title={t("sidebar.newSession")}
              aria-label={t("sidebar.newSession")}
              className={({ isActive }) => newButtonClass(isActive)}
            >
              <Plus size={14} aria-hidden />
              <span>{t("sidebar.newSession")}</span>
            </NavLink>
          ) : (
            <button
              type="button"
              title={t("newProject.title")}
              aria-label={t("newProject.title")}
              className={newButtonClass(showNewProject)}
              onClick={() => setShowNewProject(true)}
            >
              <Plus size={14} aria-hidden />
              <span>{t("newProject.title")}</span>
            </button>
          )}
        </div>
        <div ref={sessionScrollNode} className="min-h-0 flex-1 overflow-y-auto pb-24 [scrollbar-gutter:stable]">
          {signoffTab ? (
            <SignoffSidebarList
              signoffs={workspaceSignoffs.signoffs}
              unavailable={workspaceSignoffs.unavailable}
              error={workspaceSignoffs.error}
              to={(row) => `signoffs/${encodeURIComponent(row.peonId)}/${encodeURIComponent(row.id)}`}
            />
          ) : sessionListMode === "grouped" ? (
            <section>
              {projects === null && !projectError ? (
                <div className="flex min-h-12 items-center justify-center">
                  <span className="loading-spinner scale-75" role="status" aria-label={t("projects.loading")} />
                </div>
              ) : projectError && (sidebarProjects?.length ?? 0) === 0 && ordered.length === 0 ? (
                <p className="px-3 py-3 font-body text-xs text-ink-faint">{t("error.loadFailed")}</p>
              ) : (
                <ProjectGroupedSessionList
                  onPin={sessionPins.toggle}
                  isPinned={sessionPins.isPinned}
                  projects={sidebarProjects ?? []}
                  sessions={ordered}
                  projectLimit={sessionsPerProject}
                  peonId={peonId}
                  viewersFor={viewersFor}
                  projectTo={(project) => `projects/${encodeURIComponent(project.key)}`}
                  sessionTo={(session) => `sessions/${session.id}`}
                  newSessionTo={(project) => project ? `sessions/new?project=${encodeURIComponent(project.key)}` : "sessions/new"}
                  onNavigateIntent={prefetchSession}
                  onRename={renameSession}
                  onDelete={deleteSession}
                />
              )}
              {sessionPageError && (
                <div className="flex min-h-8 items-center justify-center px-3 py-2" aria-live="polite">
                  <button type="button" className="font-body text-[0.68rem] text-ink-muted hover:text-accent-strong" onClick={() => void loadNextSessions()}>
                    {t("sessions.retry")}
                  </button>
                </div>
              )}
            </section>
          ) : (
            <>
              <section>
                <div>
                  {ordered.length === 0 && !sessionsLoading && !sessionPageError ? (
                    <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("peon.dash.noSessions")}</p>
                  ) : (
                    <>
                      <SessionSidebarList
                        flush
                        onPin={sessionPins.toggle}
                        isPinned={sessionPins.isPinned}
                        sessions={ordered}
                        to={(session) => `sessions/${session.id}`}
                        peonIdFor={() => peonId}
                        viewersFor={viewersFor}
                        onNavigateIntent={prefetchSession}
                        onRename={renameSession}
                        onDelete={deleteSession}
                      />
                      <div ref={sessionLoadSentinel} className="flex min-h-8 items-center justify-center px-3 py-2" aria-live="polite">
                        {sessionsLoading && <span className="loading-spinner scale-75" role="status" aria-label={t("sessions.loading")} />}
                        {sessionPageError && (
                          <button type="button" className="font-body text-[0.68rem] text-ink-muted hover:text-accent-strong" onClick={() => void loadNextSessions()}>
                            {t("sessions.retry")}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </section>
            </>
          )}
        </div>
        {showNewProject && <NewProjectDialog base={base} onClose={() => {
          setShowNewProject(false);
          void loadProjects();
        }} />}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={sidebar.minWidth}
          aria-valuemax={sidebar.maxWidth}
          aria-valuenow={Math.round(sidebar.sidebarWidth)}
          tabIndex={0}
          className="absolute right-0 top-0 hidden h-full w-2 cursor-col-resize touch-none outline-none panel-resize-handle md:block"
          onPointerDown={(event) => {
            event.preventDefault();
            sidebar.startResize();
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const change = event.key === "ArrowLeft" ? -16 : 16;
            sidebar.nudgeWidth(change);
          }}
        />
      </aside>

      <main className="peon-main-pane min-w-0 flex-1">
        <div className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-edge bg-canvas/95 px-3 backdrop-blur md:hidden">
          <button
            type="button"
            className="-ml-1 rounded p-2 text-ink-muted transition-colors hover-wash hover:text-ink"
            aria-label={t("peon.tab.sessions")}
            aria-expanded={drawerOpen}
            aria-controls="peon-navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={20} />
          </button>
          <MobilePaneIdentity contentActive={!!sid || !!projectKey}>
            <>
              <PeonConnectionStatusDot {...displayedPeon} />
              <span className="min-w-0 flex-1 whitespace-nowrap font-display text-sm font-bold text-ink"><FadingTitle>{peon.name || t("peons.unnamed")}</FadingTitle></span>
            </>
          </MobilePaneIdentity>
        </div>
        <div className={`mx-auto w-full px-3 py-4 sm:px-6 sm:py-7 ${sid ? "" : "reveal"} ${projectPageActive ? "max-w-none" : "max-w-6xl"}`}>
          <Outlet context={ctx} />
        </div>
      </main>
    </div>
  );
}
