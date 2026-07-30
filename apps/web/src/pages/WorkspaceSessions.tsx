import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { PeonScopeSwitcher } from "../components/PeonScopeSwitcher";
import { SessionSidebarList } from "../components/SessionSidebarList";
import { SidebarSectionHeader } from "../components/SidebarSectionHeader";
import { useT } from "../i18n";
import { useLiveSocket, type SessionLiveEvent } from "../liveSocket";
import { useWorkspace } from "../workspace";
import { useMobileDrawer } from "../hooks/useMobileDrawer";
import type { PeonContext, PeonView } from "./peon/context";
import { applyAttentionEvent, applyLocalSessionRunningChange, applySessionEvent, mergeSessions, sessionFromIndex, type IndexedSessionEvent, type IndexedSessionLite, type SessionLite } from "./peon/sessionList";
import { nextSessionAfterDeletion } from "./peon/session/nextSession";
import { sessionRouteShellClass } from "./peon/session/sessionViewport";
import { prefetchTranscriptSnapshot } from "./peon/session/transcriptSnapshotCache";

const SIDEBAR_WIDTH_KEY = "overseer.peon-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 480;
const ALL_SESSION_LIMIT = 50;

function savedSidebarWidth(): number {
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= MIN_SIDEBAR_WIDTH && saved <= MAX_SIDEBAR_WIDTH
    ? saved
    : DEFAULT_SIDEBAR_WIDTH;
}

export function WorkspaceSessions() {
  const t = useT();
  const location = useLocation();
  const { workspaceId = "", peonId = "", sid = "" } = useParams();
  const navigate = useNavigate();
  const { current, groups, setCurrent } = useWorkspace();
  const { subscribeAttention, subscribeSessions, viewersFor } = useLiveSocket();
  const group = groups.find((item) => item.workspace.id === workspaceId);
  const peons = useMemo(() => group?.peons ?? [], [group]);
  const peonNames = useMemo(() => new Map(peons.map((peon) => [peon.peonId, peon.name || t("peons.unnamed")])), [peons, t]);
  const isOwner = group?.workspace.role === "owner";

  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [sessionTotal, setSessionTotal] = useState<number | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const [activePeon, setActivePeon] = useState<PeonView | null>(null);
  const [activePeonError, setActivePeonError] = useState(false);
  const { drawerOpen, setDrawerOpen } = useMobileDrawer();
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const loadEpoch = useRef(0);

  useEffect(() => {
    if (workspaceId && current?.id !== workspaceId) setCurrent(workspaceId);
  }, [current?.id, setCurrent, workspaceId]);

  const loadSessions = useCallback(async () => {
    if (!workspaceId) return;
    const epoch = ++loadEpoch.current;
    setSessionsLoading(true);
    setSessionError(false);
    try {
      const result = await api<{ sessions: IndexedSessionLite[]; total: number }>(
        `/workspaces/${encodeURIComponent(workspaceId)}/sessions?limit=${ALL_SESSION_LIMIT}&offset=0`,
      );
      if (loadEpoch.current !== epoch) return;
      setSessions((currentSessions) => mergeSessions(currentSessions, (result.sessions ?? []).map(sessionFromIndex)));
      setSessionTotal(result.total);
    } catch {
      if (loadEpoch.current === epoch) setSessionError(true);
    } finally {
      if (loadEpoch.current === epoch) setSessionsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadEpoch.current += 1;
    setSessions([]);
    setSessionTotal(null);
    void loadSessions();
    return () => { loadEpoch.current += 1; };
  }, [loadSessions]);

  useEffect(() => subscribeSessions((event: SessionLiveEvent) => {
    if (current?.id !== workspaceId) return;
    if (typeof event.peonId !== "string" || !event.peonId || typeof event.sessionId !== "string" || !event.sessionId) return;
    setSessions((currentSessions) => applySessionEvent(currentSessions, event as IndexedSessionEvent));
    if (event.deleted) setSessionTotal((total) => total === null ? null : Math.max(0, total - 1));
  }), [current?.id, subscribeSessions, workspaceId]);

  useEffect(() => subscribeAttention((event) => {
    setSessions((currentSessions) => applyAttentionEvent(currentSessions, event));
  }), [subscribeAttention]);

  const reloadActivePeon = useCallback(() => {
    if (!workspaceId || !peonId) {
      setActivePeon(null);
      setActivePeonError(false);
      return;
    }
    api<PeonView>(`/workspaces/${encodeURIComponent(workspaceId)}/peons/${encodeURIComponent(peonId)}`)
      .then((peon) => {
        setActivePeon(peon);
        setActivePeonError(false);
      })
      .catch(() => {
        setActivePeon(null);
        setActivePeonError(true);
      });
  }, [peonId, workspaceId]);

  useEffect(() => {
    reloadActivePeon();
  }, [peonId, reloadActivePeon]);

  useEffect(() => setDrawerOpen(false), [location.pathname, setDrawerOpen]);
  useEffect(() => {
    if (!resizing) return;
    const resize = (event: PointerEvent) => {
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
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--peon-sidebar-width", `${sidebarWidth}px`);
    return () => {
      root.style.removeProperty("--peon-sidebar-width");
    };
  }, [sidebarWidth]);

  const ordered = useMemo(
    () => [...sessions].sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0)),
    [sessions],
  );
  const activePeonSessionIds = ordered.filter((session) => session.peonId === peonId).map((session) => session.id);
  const onSessionRunningChange = useCallback((changedPeonId: string, sessionId: string, running: boolean, changedAt: number) => {
    setSessions((currentSessions) => applyLocalSessionRunningChange(currentSessions, changedPeonId, sessionId, running, changedAt));
  }, []);
  const outletContext: PeonContext | null = activePeon ? {
    peon: activePeon,
    wsId: workspaceId,
    base: `/workspaces/${workspaceId}/peons/${activePeon.peonId}`,
    reload: reloadActivePeon,
    isOwner,
    orderedSessionIds: activePeonSessionIds,
    selectedSession: sessions.find((session) => session.peonId === peonId && session.id === sid),
    sessionHref: (nextPeonId, sessionId) => `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(nextPeonId)}/${encodeURIComponent(sessionId)}`,
    sessionsHomeHref: `/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
    onSessionDeleted: (deletedPeonId, sessionId) => {
      setSessions((currentSessions) => currentSessions.filter((session) => session.peonId !== deletedPeonId || session.id !== sessionId));
      setSessionTotal((total) => total === null ? null : Math.max(0, total - 1));
    },
    onSessionRunningChange,
  } : null;

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
        id="workspace-session-navigation"
        data-open={drawerOpen}
        className="mobile-drawer-panel fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(20rem,86vw)] shrink-0 flex-col border-r border-iron-800 bg-iron-950 shadow-2xl md:visible md:sticky md:top-0 md:z-auto md:h-screen md:w-[var(--peon-sidebar-width)] md:translate-x-0 md:bg-iron-950/50 md:shadow-none"
      >
        <div className="border-b border-iron-800 px-3 pb-3 pt-3.5">
          <NavLink to={`/workspaces/${encodeURIComponent(workspaceId)}`} className="mb-2 inline-block font-body text-xs text-bone-dim transition-colors hover:text-fel-bright">{t("peon.back")}</NavLink>
          <div className="flex items-center gap-2">
            <PeonScopeSwitcher workspaceId={workspaceId} />
          </div>
        </div>

        <SidebarSectionHeader label={t("peon.tab.sessions")} />
        <div className="min-h-0 flex-1 overflow-y-auto pb-24">
          {sessionsLoading && ordered.length === 0 ? (
            <div className="flex min-h-20 items-center justify-center"><span className="forge-spin scale-75" role="status" aria-label={t("sessions.loading")} /></div>
          ) : sessionError && ordered.length === 0 ? (
            <button type="button" className="px-3 py-2 font-body text-xs text-bone-dim hover:text-fel-bright" onClick={() => void loadSessions()}>{t("sessions.retry")}</button>
          ) : ordered.length === 0 ? (
            <p className="px-3 py-2 font-body text-xs text-bone-faint">{t("sessions.empty")}</p>
          ) : (
            <SessionSidebarList
              sessions={ordered}
              to={(session) => `${encodeURIComponent(session.peonId ?? "")}/${encodeURIComponent(session.id)}`}
              peonIdFor={(session) => session.peonId ?? ""}
              peonNameFor={(session) => peonNames.get(session.peonId ?? "") ?? t("peons.unnamed")}
              viewersFor={viewersFor}
              onNavigateIntent={(session) => {
                const targetPeonId = session.peonId ?? "";
                void prefetchTranscriptSnapshot(
                  `/workspaces/${encodeURIComponent(workspaceId)}/peons/${encodeURIComponent(targetPeonId)}`,
                  session.id,
                  true,
                ).catch(() => {});
              }}
              onRename={async (session, title) => {
                const targetPeonId = session.peonId ?? "";
                await api(`/workspaces/${encodeURIComponent(workspaceId)}/peons/${encodeURIComponent(targetPeonId)}/sessions/${encodeURIComponent(session.id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
                setSessions((currentSessions) => currentSessions.map((item) => item.peonId === targetPeonId && item.id === session.id ? { ...item, title } : item));
              }}
              onDelete={async (session) => {
                const targetPeonId = session.peonId ?? "";
                const targetIds = ordered.filter((item) => item.peonId === targetPeonId).map((item) => item.id);
                const nextSessionId = nextSessionAfterDeletion(targetIds, session.id);
                await api(`/workspaces/${encodeURIComponent(workspaceId)}/peons/${encodeURIComponent(targetPeonId)}/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
                setSessions((currentSessions) => currentSessions.filter((item) => item.peonId !== targetPeonId || item.id !== session.id));
                setSessionTotal((total) => total === null ? null : Math.max(0, total - 1));
                if (peonId === targetPeonId && sid === session.id) {
                  navigate(nextSessionId
                    ? `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(targetPeonId)}/${encodeURIComponent(nextSessionId)}`
                    : `/workspaces/${encodeURIComponent(workspaceId)}/sessions`, { replace: true });
                }
              }}
            />
          )}
          {sessionTotal !== null && sessionTotal > ordered.length && (
            <p className="px-3 py-3 text-center font-body text-[0.65rem] text-bone-faint">{t("sessions.showingRecent", { shown: ordered.length, total: sessionTotal })}</p>
          )}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          className="absolute -right-1 top-0 hidden h-full w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-transparent hover:after:bg-fel/70 focus-visible:after:bg-fel md:block"
          onPointerDown={(event) => { event.preventDefault(); setResizing(true); }}
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
          <button type="button" className="-ml-1 rounded p-2 text-bone-dim transition-colors hover:bg-iron-900 hover:text-bone" aria-label={t("peon.tab.sessions")} aria-expanded={drawerOpen} aria-controls="workspace-session-navigation" onClick={() => setDrawerOpen(true)}>
            <Menu size={20} />
          </button>
          <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-bone">{t("sessions.allPeons")}</span>
        </div>
        <div className="mx-auto max-w-6xl px-3 py-4 reveal sm:px-6 sm:py-7">
          {peonId && !activePeon ? (
            activePeonError ? <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">{t("peon.notFound")}</p> : <div className="grid min-h-[40vh] place-items-center"><div className="forge-spin" /></div>
          ) : (
            <Outlet context={outletContext} />
          )}
        </div>
      </main>
    </div>
  );
}

export function WorkspaceSessionsEmpty() {
  const t = useT();
  return (
    <div className="grid min-h-[55vh] place-items-center text-center">
      <div>
        <h1 className="font-display text-xl font-bold text-bone">{t("sessions.allPeons")}</h1>
        <p className="mt-2 font-mono text-sm text-bone-faint">{t("sessions.choose")}</p>
      </div>
    </div>
  );
}
