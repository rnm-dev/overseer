import { useSessionPins, orderPinnedSessions } from "../sessions/useSessionPins";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BarChart3, Menu, Pickaxe, Settings, type LucideIcon } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../../shared/api";
import { useWorkspace } from "../workspaces/workspace";
import { usePeonPresence } from "./usePeonPresence";
import { useMobileDrawer } from "../../shared/useMobileDrawer";
import { useT } from "../../shared/i18n";
import { useLiveSocket, type SessionLiveEvent } from "../../realtime/liveSocket";
import { PeonScopeSwitcher } from "../workspaces/PeonScopeSwitcher";
import { ProjectGroupedSessionList } from "../sessions/ProjectGroupedSessionList";
import { FadingTitle, SessionSidebarList } from "../sessions/SessionSidebarList";
import {
  loadSessionListDisplayMode,
  loadSessionListProjectLimit,
  saveSessionListDisplayMode,
  saveSessionListProjectLimit,
  SessionListDisplayControl,
} from "../sessions/SessionListDisplayControl";
import { ProjectSidebarSection } from "../projects/ProjectSidebarSection";
import { SIDEBAR_SECTION_ACTION_CLASS, SidebarSectionHeader } from "../../shared/SidebarSectionHeader";
import { PeonConnectionStatusDot } from "./PeonConnectionStatusDot";
import type { PeonContext, PeonView } from "./context";
import { NewProjectDialog } from "../projects/NewProjectDialog";
import { applyProjectEvent, applyProjectSessionCounts, mergeProjects, withLiveActiveSessionCounts, type ProjectLite } from "../projects/projectList";
import { applyAttentionEvent, applyLocalSessionRunningChange, applySessionEvent, mergeSessions, sessionDisplayTitle, sessionFromIndex, sessionSidebarCanLoad, type IndexedSessionEvent, type IndexedSessionLite, type SessionLite } from "../sessions/sessionList";
import { MobilePaneIdentity } from "../sessions/mobileHeader";
import { nextSessionAfterDeletion } from "../sessions/nextSession";
import { sessionRouteShellClass } from "../sessions/sessionViewport";
import { prefetchTranscriptSnapshot } from "../sessions/transcriptSnapshotCache";

// author: Viktor

type PeonNavItem = {
  to: string;
  key: "peon.tab.work" | "peon.tab.stats" | "peon.tab.resources";
  icon: LucideIcon;
};

// Work is the Peon landing view. Projects live in the sidebar, leaving the
// compact icon rail for Work, Stats, and Settings.
export const PEON_NAV_ITEMS: readonly PeonNavItem[] = [
  { to: "sessions", key: "peon.tab.work", icon: Pickaxe },
  { to: "stats", key: "peon.tab.stats", icon: BarChart3 },
  { to: "resources", key: "peon.tab.resources", icon: Activity },
];

const iconNavClass = (active: boolean) =>
  `rounded p-1.5 transition-colors ${active ? "bg-accent/10 text-accent-strong" : "text-ink-muted hover:bg-surface-hover hover:text-ink"}`;

const SIDEBAR_WIDTH_KEY = "overseer.peon-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 480;
const WORKING_TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SESSION_PAGE_SIZE = 50;

export function sessionListRequestPath(workspaceId: string, peonId: string, mode: "grouped" | "flat", projectLimit: number, offset: number): string {
  const base = `/workspaces/${workspaceId}/sessions?peonId=${encodeURIComponent(peonId)}`;
  return mode === "grouped"
    ? `${base}&perProjectLimit=${projectLimit}`
    : `${base}&limit=${SESSION_PAGE_SIZE}&offset=${offset}`;
}

export function isProjectPath(pathname: string): boolean {
  return /\/projects\/[^/]+(?:\/.*)?$/.test(pathname);
}

function savedSidebarWidth(): number {
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= MIN_SIDEBAR_WIDTH && saved <= MAX_SIDEBAR_WIDTH
    ? saved
    : DEFAULT_SIDEBAR_WIDTH;
}

export function PeonDetail() {
  const t = useT();
  const { peonId = "", sid = "", key: projectKey = "" } = useParams();
  const { viewersFor, subscribeAttention, subscribeProjects, subscribeSessions } = useLiveSocket();
  const location = useLocation();
  const navigate = useNavigate();
  const { current, workspaces, setCurrent, workspaceIdOfPeon } = useWorkspace();
  const wsOfPeon = workspaceIdOfPeon(peonId);
  const wsId = wsOfPeon ?? current?.id;
  const sessionPins = useSessionPins(wsId, peonId);
  const base = `/workspaces/${wsId}/peons/${peonId}`;
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
  const [sessionsPerProject, setSessionsPerProject] = useState(loadSessionListProjectLimit);
  const { drawerOpen, setDrawerOpen } = useMobileDrawer();
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const sessionScrollNode = useRef<HTMLDivElement>(null);
  const sessionLoadSentinel = useRef<HTMLDivElement>(null);
  const sessionLoadEpoch = useRef(0);
  const sessionLoading = useRef(false);
  const nextSessionOffset = useRef(0);
  const { online } = usePeonPresence(peonId, wsId);
  const onSessionRunningChange = useCallback((changedPeonId: string, sessionId: string, running: boolean, changedAt: number) => {
    setSessions((current) => applyLocalSessionRunningChange(current, changedPeonId, sessionId, running, changedAt));
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const resize = (event: PointerEvent) => {
      // Leave enough room for the current page to remain useful on narrower desktops.
      const maximum = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 320);
      setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximum, event.clientX)));
    };
    const stop = () => setResizing(false);
    document.documentElement.classList.add("peon-sidebar-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.documentElement.classList.remove("peon-sidebar-resizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  useEffect(() => {
    if (!resizing) window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [resizing, sidebarWidth]);

  // Headers and the session composer live outside this component's flex layout.
  // Publish the width so those fixed pieces share the pane's desktop boundary.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--peon-sidebar-width", `${sidebarWidth}px`);
    return () => {
      root.style.removeProperty("--peon-sidebar-width");
    };
  }, [sidebarWidth]);

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

  // Keep browser tabs identifiable when several peons/sessions are open. While
  // the selected session is running, animate a small spinner so background work
  // remains visible even when this tab is not focused.
  useEffect(() => {
    if (!peon) return;
    const previousTitle = document.title;
    const peonName = peon.name || peon.hostname || t("peons.unnamed");
    const session = sid ? sessions.find((item) => item.id === sid) : undefined;
    const sessionName = session ? sessionDisplayTitle(session, t("session.untitled")) : null;
    const baseTitle = sessionName ? `${peonName} — ${sessionName} · Overseer` : `${peonName} · Overseer`;
    let frame = 0;
    const update = () => {
      document.title = session?.status === "running" ? `${WORKING_TITLE_FRAMES[frame++ % WORKING_TITLE_FRAMES.length]} ${baseTitle}` : baseTitle;
    };
    update();
    const timer = session?.status === "running" ? window.setInterval(update, 250) : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      document.title = previousTitle;
    };
  }, [peon, sessions, sid, t]);

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
        className="mobile-drawer-panel fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(20rem,86vw)] shrink-0 flex-col border-r border-edge bg-surface shadow-2xl md:visible md:sticky md:top-0 md:z-auto md:h-screen md:w-[var(--peon-sidebar-width)] md:translate-x-0 md:bg-surface/50 md:shadow-none"
      >
        {/* header: back + workspace-wide Peon scope switcher */}
        <div className="border-b border-edge px-3 pb-3 pt-3.5">
          <Link to="/" className="mb-2 inline-block font-body text-xs text-ink-muted transition-colors hover:text-accent-strong">
            {t("peon.back")}
          </Link>
          <div className="flex items-center justify-between gap-2">
            <PeonScopeSwitcher workspaceId={wsId!} peonId={peonId} />
            <div className="flex flex-none items-center gap-1">
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

        <div ref={sessionScrollNode} className="min-h-0 flex-1 overflow-y-auto pb-24">
          <SessionListDisplayControl
            mode={sessionListMode}
            projectLimit={sessionsPerProject}
            onModeChange={(mode) => {
              setSessionListMode(mode);
              saveSessionListDisplayMode(mode);
            }}
            onProjectLimitChange={(limit) => {
              setSessionsPerProject(limit);
              saveSessionListProjectLimit(limit);
            }}
          />
          {sessionListMode === "grouped" ? (
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
                  onNewProject={() => setShowNewProject(true)}
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
              <ProjectSidebarSection
                projects={sidebarProjects}
                error={projectError}
                to={(project) => `projects/${encodeURIComponent(project.key)}`}
                onNew={() => setShowNewProject(true)}
              />

              {/* The original flat session list remains available as a display mode. */}
              <section>
                <SidebarSectionHeader
                  label={t("peon.tab.sessions")}
                  action={(
                    <Link to={newSessionTo} className={SIDEBAR_SECTION_ACTION_CLASS}>
                      {t("newSession.new")}
                    </Link>
                  )}
                />
                <div>
                  {ordered.length === 0 && !sessionsLoading && !sessionPageError ? (
                    <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("peon.dash.noSessions")}</p>
                  ) : (
                    <>
                      <SessionSidebarList
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
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          className="absolute -right-1 top-0 hidden h-full w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-transparent hover:after:bg-accent/70 focus-visible:after:bg-accent md:block"
          onPointerDown={(event) => {
            event.preventDefault();
            setResizing(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const change = event.key === "ArrowLeft" ? -16 : 16;
            setSidebarWidth((width) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width + change)));
          }}
        />
      </aside>

      <main className="peon-main-pane min-w-0 flex-1">
        <div className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-edge bg-canvas/95 px-3 backdrop-blur md:hidden">
          <button
            type="button"
            className="-ml-1 rounded p-2 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
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
