import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Pencil, Trash2 } from "lucide-react";
import { NavLink } from "react-router";
import { ApiError, isPeonNeedsUpdate } from "../../shared/api";
import { useI18n, useT } from "../../shared/i18n";
import type { PresenceUser } from "../../realtime/liveSocket";
import { useNotifications } from "../../shared/notifications";
import { sessionDisplayTitle, sessionIdentity, type SessionLite } from "./sessionList";
import { formatLocalTimestamp } from "../../shared/timeFormat";
import { Button, ConfirmationDialog, Dialog, Label } from "../../shared/ui";
import { SessionPresence } from "./SessionPresence";
import { rowEdgeClass, SIDEBAR_ROW_EDGE_IDLE_CLASS, useRowUpdateFlashes } from "../../shared/SidebarSectionHeader";

export function sessionStatusEdgeClass(status?: string | null, attentionUnread = false): string {
  return status === "running"
    ? "bg-accent-strong status-edge status-edge--accent"
    : attentionUnread || status === "needs_human"
      ? "bg-warning status-edge status-edge--warning"
      : status === "failure" || status === "failed" || status === "error"
        ? "bg-danger status-edge status-edge--danger"
        : SIDEBAR_ROW_EDGE_IDLE_CLASS;
}

export function FadingTitle({ children }: { children: ReactNode }) {
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

const CONTEXT_MENU_WIDTH = 160;
const CONTEXT_MENU_HEIGHT = 82;
const CONTEXT_MENU_MARGIN = 8;

export function sessionContextMenuPosition(clientX: number, clientY: number, viewportWidth: number, viewportHeight: number) {
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(clientX, viewportWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(clientY, viewportHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN)),
  };
}

export function sessionRenameDraft(session: SessionLite): string {
  return sessionDisplayTitle(session, "");
}

// What a live session update can change in a row. Any of these moving means the
// Peon told us something new about that session, which is what the flash marks.
export function sessionRowFingerprint(session: SessionLite): string {
  return [
    session.status ?? "",
    session.lastActivityAt ?? 0,
    session.lastMessagePreview ?? "",
    session.title ?? "",
    session.attentionUnread ? "unread" : "",
    session.catalogState ?? "",
  ].join("|");
}

export function SessionSidebarList({
  sessions,
  to,
  peonIdFor,
  peonNameFor,
  viewersFor,
  onRename,
  onDelete,
  onNavigateIntent,
  appearance = "sidebar",
}: {
  sessions: SessionLite[];
  to: (session: SessionLite) => string;
  peonIdFor: (session: SessionLite) => string;
  peonNameFor?: (session: SessionLite) => string | null;
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
  onRename: (session: SessionLite, title: string | null) => Promise<void>;
  onDelete: (session: SessionLite) => Promise<void>;
  onNavigateIntent?: (session: SessionLite) => void;
  appearance?: "sidebar" | "panel";
}) {
  const t = useT();
  const { locale } = useI18n();
  const { notifyError } = useNotifications();
  const sessionNodes = useRef(new Map<string, HTMLLIElement>());
  const previousSessionTops = useRef(new Map<string, number>());
  const sessionMoveAnimations = useRef(new Map<string, Animation>());
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ session: SessionLite; x: number; y: number } | null>(null);
  const [renameSession, setRenameSession] = useState<SessionLite | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleteSession, setDeleteSession] = useState<SessionLite | null>(null);
  const [deleting, setDeleting] = useState(false);
  const flashes = useRowUpdateFlashes(sessions.map((session) => ({
    key: sessionIdentity(session),
    fingerprint: sessionRowFingerprint(session),
  })));

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const closeOnViewportChange = () => setContextMenu(null);
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [contextMenu]);

  const beginRename = (session: SessionLite) => {
    setRenameSession(session);
    setRenameDraft(sessionRenameDraft(session));
    setContextMenu(null);
  };

  const saveRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!renameSession || renaming) return;
    setRenaming(true);
    try {
      await onRename(renameSession, renameDraft.trim() || null);
      setRenameSession(null);
    } catch (error) {
      notifyError(error, {
        title: t("session.rename.failed"),
        fallback: t("error.generic"),
        message: isPeonNeedsUpdate(error) ? t("peon.unsupported") : undefined,
      });
    } finally {
      setRenaming(false);
    }
  };

  const confirmDeletion = async () => {
    if (!deleteSession || deleting) return;
    setDeleting(true);
    try {
      await onDelete(deleteSession);
      setDeleteSession(null);
    } catch (error) {
      notifyError(error, {
        title: t("session.delete.failed"),
        fallback: t("error.generic"),
        message: error instanceof ApiError && error.status === 409
          ? t("session.delete.running")
          : isPeonNeedsUpdate(error) ? t("peon.unsupported") : undefined,
      });
      setDeleteSession(null);
    } finally {
      setDeleting(false);
    }
  };

  // FLIP existing rows into their new activity order. Newly inserted sessions
  // have no previous position and appear directly at their authoritative slot.
  useLayoutEffect(() => {
    const animations = sessionMoveAnimations.current;
    for (const animation of animations.values()) animation.cancel();
    animations.clear();

    const nextTops = new Map<string, number>();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const session of sessions) {
      const key = sessionIdentity(session);
      const node = sessionNodes.current.get(key);
      if (!node) continue;
      const nextTop = node.offsetTop;
      const previousTop = previousSessionTops.current.get(key);
      nextTops.set(key, nextTop);
      if (reduceMotion || previousTop === undefined) continue;

      const delta = previousTop - nextTop;
      if (Math.abs(delta) < 1) continue;
      const animation = node.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
      animations.set(key, animation);
      const forgetAnimation = () => {
        if (animations.get(key) === animation) animations.delete(key);
      };
      animation.addEventListener("finish", forgetAnimation, { once: true });
      animation.addEventListener("cancel", forgetAnimation, { once: true });
    }
    previousSessionTops.current = nextTops;

    return () => {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    };
  }, [sessions]);

  return (
    <ul className="py-1">
      {sessions.map((session) => {
        const key = sessionIdentity(session);
        const flash = flashes.get(key);
        const peonId = peonIdFor(session);
        const peonName = peonNameFor?.(session);
        return (
          <li
            key={key}
            className="relative"
            onContextMenu={(event) => {
              event.preventDefault();
              const position = sessionContextMenuPosition(event.clientX, event.clientY, window.innerWidth, window.innerHeight);
              setContextMenu({ session, ...position });
            }}
            ref={(node) => {
              if (node) sessionNodes.current.set(key, node);
              else sessionNodes.current.delete(key);
            }}
          >
            <NavLink
              to={to(session)}
              onPointerEnter={() => onNavigateIntent?.(session)}
              onPointerDown={() => onNavigateIntent?.(session)}
              onFocus={() => onNavigateIntent?.(session)}
              title={session.catalogStale ? t("session.catalogStaleTitle") : undefined}
              className={({ isActive }) => `relative block py-1.5 pl-3 pr-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${session.catalogStale ? "opacity-70" : ""} ${isActive ? "bg-accent/10" : appearance === "panel" ? "hover:bg-surface-hover/70" : "hover:bg-surface-raised"}`}
            >
              <span
                key={`edge-${flash ?? 0}`}
                className={rowEdgeClass(sessionStatusEdgeClass(session.status, session.attentionUnread), flash)}
                aria-hidden
              />
              {/* min-h-5 matches the sm avatar so viewers appearing/leaving never resize the row. */}
              <div className="flex min-h-5 items-center gap-2">
                <span className="min-w-0 flex-1 whitespace-nowrap font-body typo-chat-message text-ink">
                  <FadingTitle>{sessionDisplayTitle(session, t("session.untitled"))}</FadingTitle>
                </span>
                <SessionPresence viewers={viewersFor(peonId, session.id)} size="sm" />
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-body text-[0.6875rem] text-ink-faint">
                {peonName && <span className="max-w-[35%] flex-none truncate text-ink-muted">{peonName}</span>}
                {session.projectKey && <span className="max-w-[30%] flex-none truncate font-body text-warning/80">{session.projectKey}</span>}
                {session.catalogStale && (
                  <span className="flex-none font-mono uppercase tracking-wide text-warning/70">
                    {session.catalogState === "syncing" ? t("session.catalogSyncing") : t("session.catalogStale")}
                  </span>
                )}
                {session.lastMessagePreview && (
                  <span className="min-w-0 flex-1 whitespace-nowrap" title={session.lastMessagePreview}>
                    <FadingTitle>{session.lastMessagePreview}</FadingTitle>
                  </span>
                )}
                <span className="ml-auto flex-none font-body tabular-nums">
                  {formatLocalTimestamp(session.lastActivityAt ?? session.startedAt ?? 0, Date.now(), locale, t("peon.stats.period.yesterday"))}
                </span>
              </div>
            </NavLink>
          </li>
        );
      })}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[110] w-40 overflow-hidden rounded-lg border border-edge bg-surface py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-body text-xs text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            onClick={() => beginRename(contextMenu.session)}
          >
            <Pencil size={13} aria-hidden />
            {t("session.rename")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-body text-xs text-danger transition-colors hover:bg-danger/10"
            onClick={() => {
              setDeleteSession(contextMenu.session);
              setContextMenu(null);
            }}
          >
            <Trash2 size={13} aria-hidden />
            {t("session.delete")}
          </button>
        </div>,
        document.body,
      )}
      {renameSession && (
        <Dialog title={t("session.rename")} onClose={() => setRenameSession(null)} dismissible={!renaming}>
          <form className="space-y-4" onSubmit={saveRename}>
            <div>
              <Label>{t("session.renamePlaceholder")}</Label>
              <input
                autoFocus
                value={renameDraft}
                disabled={renaming}
                onChange={(event) => setRenameDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-2 w-full rounded-lg border border-edge-strong bg-surface px-3 py-2 font-body text-sm text-ink outline-none transition-colors focus:border-accent/70 disabled:cursor-wait disabled:opacity-60"
              />
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" disabled={renaming} onClick={() => setRenameSession(null)}>{t("action.cancel")}</Button>
              <Button type="submit" variant="accent" disabled={renaming}>{t("session.rename.save")}</Button>
            </div>
          </form>
        </Dialog>
      )}
      {deleteSession && (
        <ConfirmationDialog
          title={t("session.delete.confirm")}
          confirmLabel={t("session.delete.confirmYes")}
          pendingLabel={t("session.delete.deleting")}
          pending={deleting}
          onClose={() => setDeleteSession(null)}
          onConfirm={() => void confirmDeletion()}
        />
      )}
    </ul>
  );
}
