import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useT } from "../i18n";
import type { PresenceUser } from "../liveSocket";
import { sessionDisplayTitle, sessionIdentity, type SessionLite } from "../pages/peon/sessionList";
import { SessionPresence } from "./SessionPresence";

function ago(ms?: number | null): string {
  if (!ms) return "";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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

export function SessionSidebarList({
  sessions,
  to,
  peonIdFor,
  peonNameFor,
  viewersFor,
}: {
  sessions: SessionLite[];
  to: (session: SessionLite) => string;
  peonIdFor: (session: SessionLite) => string;
  peonNameFor?: (session: SessionLite) => string | null;
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
}) {
  const t = useT();
  const sessionNodes = useRef(new Map<string, HTMLLIElement>());
  const previousSessionTops = useRef(new Map<string, number>());
  const sessionMoveAnimations = useRef(new Map<string, Animation>());

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
    <ul className="space-y-0.5">
      {sessions.map((session) => {
        const key = sessionIdentity(session);
        const peonId = peonIdFor(session);
        const peonName = peonNameFor?.(session);
        return (
          <li
            key={key}
            ref={(node) => {
              if (node) sessionNodes.current.set(key, node);
              else sessionNodes.current.delete(key);
            }}
          >
            <NavLink
              to={to(session)}
              title={session.catalogStale ? t("session.catalogStaleTitle") : undefined}
              className={({ isActive }) => `block rounded px-2.5 py-1.5 transition-colors ${session.catalogStale ? "opacity-70" : ""} ${isActive ? "bg-fel/10" : "hover:bg-iron-900"}`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 flex-none rounded-full ${statusColor(session.status)}`} aria-hidden />
                <span className="min-w-0 flex-1 whitespace-nowrap font-display text-[0.8rem] text-bone">
                  <FadingTitle>{sessionDisplayTitle(session, t("session.untitled"))}</FadingTitle>
                </span>
                <SessionPresence viewers={viewersFor(peonId, session.id)} size="xs" />
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-3 font-body text-[0.65rem] text-bone-faint">
                {peonName && <span className="max-w-[35%] flex-none truncate text-bone-dim">{peonName}</span>}
                {session.projectKey && <span className="max-w-[30%] flex-none truncate font-mono text-forge/80">{session.projectKey}</span>}
                {session.catalogStale && (
                  <span className="flex-none font-mono uppercase tracking-wide text-forge/70">
                    {session.catalogState === "syncing" ? t("session.catalogSyncing") : t("session.catalogStale")}
                  </span>
                )}
                {session.lastMessagePreview && (
                  <span className="min-w-0 flex-1 whitespace-nowrap" title={session.lastMessagePreview}>
                    <FadingTitle>{session.lastMessagePreview}</FadingTitle>
                  </span>
                )}
                <span className="ml-auto flex-none font-mono tabular-nums">{ago(session.lastActivityAt ?? session.startedAt)}</span>
              </div>
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}
