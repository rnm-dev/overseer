import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Menu, Settings, X } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useWorkspace } from "../workspace";
import { StatusDot } from "../ui";
import { useT } from "../i18n";
import type { PeonContext, PeonView } from "./peon/context";

// author: Viktor

// Top-level nav for the peon view — sits above the session list in the sidebar.
// Settings is reached via the cog by the peon name, not from here.
const NAV = [
  { to: "", key: "peon.tab.dashboard", end: true },
  { to: "projects", key: "peon.tab.projects", end: false },
  { to: "stats", key: "peon.tab.stats", end: false },
] as const;

interface SessionLite {
  id: string;
  status?: string | null;
  title?: string | null;
  prompt?: string | null;
  projectKey?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
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
function statusColor(status?: string | null): string {
  return status === "running"
    ? "bg-fel shadow-[0_0_6px_var(--color-fel)]"
    : status === "needs_human"
      ? "bg-forge shadow-[0_0_6px_var(--color-forge)]"
      : status === "failure" || status === "failed" || status === "error"
        ? "bg-blood"
        : "bg-iron-700";
}

const navClass = (active: boolean) =>
  `flex items-center gap-2 rounded px-2.5 py-1.5 font-display text-[0.8rem] transition-colors ${
    active ? "bg-fel/10 text-fel-bright" : "text-bone-dim hover:bg-iron-900 hover:text-bone"
  }`;

const SIDEBAR_WIDTH_KEY = "overseer.peon-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 480;
const WORKING_TITLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function savedSidebarWidth(): number {
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= MIN_SIDEBAR_WIDTH && saved <= MAX_SIDEBAR_WIDTH
    ? saved
    : DEFAULT_SIDEBAR_WIDTH;
}

function FadingTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollWidth > node.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children]);

  return <span ref={ref} className={`title-fade${overflows ? " title-fade--overflow" : ""}`}>{children}</span>;
}

export function PeonDetail() {
  const t = useT();
  const { peonId = "", sid = "" } = useParams();
  const location = useLocation();
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
  const [sessions, setSessions] = useState<SessionLite[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const [resizing, setResizing] = useState(false);

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

  // Headers, the session composer, and the account card are portaled or live
  // outside this component's flex layout. Publish the width at the document
  // level so those fixed pieces share the same desktop boundary as the pane.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("peon-layout-active");
    root.style.setProperty("--peon-sidebar-width", `${sidebarWidth}px`);
    return () => {
      root.classList.remove("peon-layout-active");
      root.style.removeProperty("--peon-sidebar-width");
    };
  }, [sidebarWidth]);

  // Route changes select an item from the mobile drawer. Close it immediately
  // so the newly selected page is visible, and keep background content from
  // scrolling while the drawer is open.
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.classList.add("peon-drawer-open");
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.body.classList.remove("peon-drawer-open");
      document.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

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

  // Sessions for the sidebar list — polled while the peon is online.
  const online = peon?.online;
  useEffect(() => {
    if (!wsId || !online) {
      setSessions([]);
      return;
    }
    let alive = true;
    const pull = () => api<{ sessions: SessionLite[] }>(`${base}/sessions`).then((r) => alive && setSessions(r.sessions ?? [])).catch(() => {});
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [base, wsId, online]);

  // Keep browser tabs identifiable when several peons/sessions are open. While
  // the selected session is running, animate a small spinner so background work
  // remains visible even when this tab is not focused.
  useEffect(() => {
    if (!peon) return;
    const previousTitle = document.title;
    const peonName = peon.name || peon.hostname || t("peons.unnamed");
    const session = sid ? sessions.find((item) => item.id === sid) : undefined;
    const sessionName = session ? session.title || session.prompt || t("session.untitled") : null;
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

  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-7">
        <Link to="/" className="font-mono text-xs text-bone-dim hover:text-fel-bright">
          {t("peon.back")}
        </Link>
        <p className="mt-4 border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>
      </div>
    );
  }
  if (!peon) return <div className="grid min-h-screen place-items-center"><div className="forge-spin" /></div>;

  const ctx: PeonContext = { peon, wsId: wsId!, base, reload };
  // Same ordering as the session list page: newest activity first.
  const ordered = [...sessions].sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0));
  return (
    <div className="flex min-h-screen">
      {drawerOpen && (
        <button
          type="button"
          aria-label={t("a11y.close")}
          className="fixed inset-0 z-40 bg-black/65 backdrop-blur-[1px] md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        id="peon-navigation"
        className={`fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-[min(20rem,86vw)] shrink-0 flex-col border-r border-iron-800 bg-iron-950 shadow-2xl transition-[transform,visibility] duration-200 md:visible md:sticky md:top-0 md:z-auto md:h-screen md:w-[var(--peon-sidebar-width)] md:translate-x-0 md:bg-iron-950/50 md:shadow-none ${
          drawerOpen ? "visible translate-x-0" : "invisible -translate-x-full md:visible"
        }`}
      >
        {/* header: back + name + settings cog */}
        <div className="border-b border-iron-800 px-3 pb-3 pt-3.5">
          <Link to="/" className="mb-2 inline-block font-mono text-xs text-bone-dim transition-colors hover:text-fel-bright">
            {t("peon.back")}
          </Link>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot state={peon.online ? "on" : "off"} />
              <h1 className="min-w-0 flex-1 whitespace-nowrap font-display text-base font-extrabold tracking-wide text-bone"><FadingTitle>{peon.name || t("peons.unnamed")}</FadingTitle></h1>
            </div>
            <div className="flex flex-none items-center gap-1">
              <NavLink
                to="settings"
                title={t("peon.tab.settings")}
                aria-label={t("peon.tab.settings")}
                className={({ isActive }) =>
                  `rounded p-1.5 transition-colors ${isActive ? "bg-fel/10 text-fel-bright" : "text-bone-dim hover:bg-iron-800 hover:text-bone"}`
                }
              >
                <Settings size={16} />
              </NavLink>
              <button
                type="button"
                className="rounded p-1.5 text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone md:hidden"
                aria-label={t("a11y.close")}
                onClick={() => setDrawerOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* nav: overview / projects / stats */}
        <nav className="space-y-0.5 px-2 py-2">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => navClass(isActive)}>
              {t(n.key)}
            </NavLink>
          ))}
        </nav>

        {/* sessions list */}
        <div className="flex items-center justify-between px-3.5 pb-1 pt-2">
          <span className="font-display text-[0.58rem] uppercase tracking-[0.16em] text-bone-faint">{t("peon.tab.sessions")}</span>
          <Link
            to={newSessionTo}
            className="font-display text-[0.58rem] uppercase tracking-[0.16em] text-bone-dim transition-colors hover:text-fel-bright"
          >
            {t("newSession.new")}
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-24">
          {!peon.online ? (
            <p className="px-2 py-2 font-mono text-xs text-bone-faint">{t("peon.offlineNote")}</p>
          ) : ordered.length === 0 ? (
            <p className="px-2 py-2 font-mono text-xs text-bone-faint">{t("peon.dash.noSessions")}</p>
          ) : (
            <ul className="space-y-0.5">
              {ordered.map((s) => (
                <li key={s.id}>
                  <NavLink
                    to={`sessions/${s.id}`}
                    className={({ isActive }) =>
                      `block rounded px-2.5 py-1.5 transition-colors ${isActive ? "bg-fel/10" : "hover:bg-iron-900"}`
                    }
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 flex-none rounded-full ${statusColor(s.status)}`} aria-hidden />
                      <span className="min-w-0 flex-1 whitespace-nowrap font-display text-[0.8rem] text-bone"><FadingTitle>{s.title || s.prompt || t("session.untitled")}</FadingTitle></span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3 font-mono text-[0.65rem] text-bone-faint">
                      {s.projectKey && <span className="truncate text-forge/80">{s.projectKey}</span>}
                      <span className="ml-auto flex-none tabular-nums">{ago(s.lastActivityAt ?? s.startedAt)}</span>
                    </div>
                  </NavLink>
                </li>
              ))}
            </ul>
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
          <StatusDot state={peon.online ? "on" : "off"} />
          <span className="min-w-0 flex-1 whitespace-nowrap font-display text-sm font-bold text-bone"><FadingTitle>{peon.name || t("peons.unnamed")}</FadingTitle></span>
          {sid && <span className="ml-auto flex-none font-mono text-[0.68rem] text-bone-faint">{t("peon.tab.sessions")}</span>}
        </div>
        <div className="mx-auto max-w-6xl px-3 py-4 reveal sm:px-6 sm:py-7">
          <Outlet context={ctx} />
        </div>
      </main>
    </div>
  );
}
