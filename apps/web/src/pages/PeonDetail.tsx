import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Menu, Pickaxe, Settings, type LucideIcon } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api";
import { useWorkspace } from "../workspace";
import { usePeonPresence } from "../hooks/usePeonPresence";
import { useMobileDrawer } from "../hooks/useMobileDrawer";
import { useT } from "../i18n";
import { useLiveSocket, type SessionLiveEvent } from "../liveSocket";
import { PeonScopeSwitcher } from "../components/PeonScopeSwitcher";
import { FadingTitle, SessionSidebarList } from "../components/SessionSidebarList";
import { ProjectSidebarSection } from "../components/ProjectSidebarSection";
import { SIDEBAR_SECTION_ACTION_CLASS, SidebarSectionHeader } from "../components/SidebarSectionHeader";
import { PeonConnectionStatusDot } from "../components/PeonConnectionStatusDot";
import type { PeonContext, PeonView } from "./peon/context";
import { NewProjectDialog } from "./peon/NewProjectDialog";
import { applyProjectEvent, mergeProjects, withLiveActiveSessionCounts, type ProjectLite } from "./peon/projectList";
import { applyAttentionEvent, applyLocalSessionRunningChange, applySessionEvent, mergeSessions, sessionDisplayTitle, sessionFromIndex, sessionSidebarCanLoad, type IndexedSessionEvent, type IndexedSessionLite, type SessionLite } from "./peon/sessionList";
import { MobilePaneIdentity } from "./peon/session/mobileHeader";
import { nextSessionAfterDeletion } from "./peon/session/nextSession";

// author: Viktor

type PeonNavItem = {
  to: string;
  key: "peon.tab.work" | "peon.tab.stats";
  icon: LucideIcon;
  ownerOnly?: boolean;
};

// Work is the Peon landing view. Projects live in the sidebar, leaving the
// compact icon rail for Work, Stats, and Settings.
const NAV: readonly PeonNavItem[] = [
  { to: "sessions", key: "peon.tab.work", icon: Pickaxe },
  { to: "stats", key: "peon.tab.stats", icon: BarChart3, ownerOnly: true },
];

const iconNavClass = (active: boolean) =>
  `rounded p-1.5 transition-colors ${active ? "bg-fel/10 text-fel-bright" : "text-bone-dim hover:bg-iron-800 hover:text-bone"}`;

const SIDEBAR_WIDTH_KEY = "overseer.peon-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 480;
const WORKING_TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SESSION_PAGE_SIZE = 50;

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
      const result = await api<{ sessions: IndexedSessionLite[]; total: number }>(
        `/workspaces/${wsId}/sessions?peonId=${encodeURIComponent(peonId)}&limit=${SESSION_PAGE_SIZE}&offset=${offset}`,
      );
      if (sessionLoadEpoch.current !== epoch) return;
      const page = (result.sessions ?? []).map(sessionFromIndex);
      const nextOffset = offset + page.length;
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
  }, [peonId, wsId]);

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
    if (!root || !target || !hasMoreSessions || sessionsLoading || sessionPageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNextSessions();
      },
      { root, rootMargin: "0px 0px 160px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMoreSessions, loadNextSessions, sessionPageError, sessionsLoading]);

  // Session summaries arrive over the resumable workspace socket after the
  // initial indexed page is hydrated.
  useEffect(() => subscribeSessions((event: SessionLiveEvent) => {
    if (event.peonId !== peonId || typeof event.sessionId !== "string" || !event.sessionId) return;
    // Keep the Peon-qualified identity used by indexed HTTP summaries. Omitting
    // peonId here made a freshly pushed session use the unscoped `sessionId`
    // key; the next index refresh then treated the same record as a second row
    // under `peonId + sessionId` until a page reload cleared local state.
    setSessions((current) => applySessionEvent(current, event as IndexedSessionEvent));
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
  const ordered = [...sessions].sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0));
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
        <Link to="/" className="font-body text-xs text-bone-dim hover:text-fel-bright">
          {t("peon.back")}
        </Link>
        <p className="mt-4 border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>
      </div>
    );
  }
  if (!peon) return <div className="grid min-h-screen place-items-center"><div className="forge-spin" /></div>;

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
    <div className="flex min-h-screen">
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
        className="mobile-drawer-panel fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(20rem,86vw)] shrink-0 flex-col border-r border-iron-800 bg-iron-950 shadow-2xl md:visible md:sticky md:top-0 md:z-auto md:h-screen md:w-[var(--peon-sidebar-width)] md:translate-x-0 md:bg-iron-950/50 md:shadow-none"
      >
        {/* header: back + workspace-wide Peon scope switcher */}
        <div className="border-b border-iron-800 px-3 pb-3 pt-3.5">
          <Link to="/" className="mb-2 inline-block font-body text-xs text-bone-dim transition-colors hover:text-fel-bright">
            {t("peon.back")}
          </Link>
          <div className="flex items-center justify-between gap-2">
            <PeonScopeSwitcher workspaceId={wsId!} peonId={peonId} />
            <div className="flex flex-none items-center gap-1">
              {NAV.filter((item) => isOwner || !item.ownerOnly).map((item) => {
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
          <ProjectSidebarSection
            projects={sidebarProjects}
            error={projectError}
            to={(project) => `projects/${encodeURIComponent(project.key)}`}
            onNew={isOwner ? () => setShowNewProject(true) : undefined}
          />

          {/* sessions list */}
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
              {!online && <p className="px-3 py-2 font-body text-xs text-bone-faint">{t("peon.offlineNote")}</p>}
              {ordered.length === 0 && !sessionsLoading && !sessionPageError ? (
                <p className="px-3 py-2 font-body text-xs text-bone-faint">{t("peon.dash.noSessions")}</p>
              ) : (
                <>
                  <SessionSidebarList
                    sessions={ordered}
                    to={(session) => `sessions/${session.id}`}
                    peonIdFor={() => peonId}
                    viewersFor={viewersFor}
                    onRename={renameSession}
                    onDelete={deleteSession}
                  />
                  <div ref={sessionLoadSentinel} className="flex min-h-8 items-center justify-center px-3 py-2" aria-live="polite">
                    {sessionsLoading && <span className="forge-spin scale-75" role="status" aria-label={t("sessions.loading")} />}
                    {sessionPageError && (
                      <button type="button" className="font-body text-[0.68rem] text-bone-dim hover:text-fel-bright" onClick={() => void loadNextSessions()}>
                        {t("sessions.retry")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>
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
          className="absolute -right-1 top-0 hidden h-full w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-transparent hover:after:bg-fel/70 focus-visible:after:bg-fel md:block"
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
        <div className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-iron-800 bg-void/95 px-3 backdrop-blur md:hidden">
          <button
            type="button"
            className="-ml-1 rounded p-2 text-bone-dim transition-colors hover:bg-iron-900 hover:text-bone"
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
              <span className="min-w-0 flex-1 whitespace-nowrap font-display text-sm font-bold text-bone"><FadingTitle>{peon.name || t("peons.unnamed")}</FadingTitle></span>
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
