import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api";
import { sessionFromIndex, type IndexedSessionLite, type SessionLite } from "./sessionList";
const changedEvent = "overseer:session-pins-changed";
export function refreshSessionPins() { window.dispatchEvent(new Event(changedEvent)); }
export function orderPinnedSessions(sessions: SessionLite[], pins: SessionLite[], peonId?: string): SessionLite[] {
  const key = (s: SessionLite) => `${s.peonId || peonId}:${s.id}`;
  const pinned = new Set(pins.map(key));
  const map = new Map(pins.map((session) => [key(session), session]));
  for (const session of sessions) map.set(key(session), session);
  return [...map.values()].sort((a,b) => Number(pinned.has(key(b))) - Number(pinned.has(key(a))) || (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0));
}
export function useSessionPins(workspaceId: string | undefined, peonId?: string) {
  const [pins, setPins] = useState<SessionLite[]>([]);
  const scope = useRef(0);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    let request = 0;
    scope.current += 1;
    setPins([]);
    const load = async () => {
      if (!workspaceId) return;
      const id = ++request;
      try {
        const response = await api<{ sessions: IndexedSessionLite[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/session-pins`);
        if (alive && request === id) setPins(response.sessions.map(sessionFromIndex));
      } catch { /* Keep last successful pins; mutation errors reach the row's notification. */ }
    };
    reload.current = () => { void load(); };
    void load();
    window.addEventListener(changedEvent, reload.current);
    window.addEventListener("focus", reload.current);
    return () => { alive = false; scope.current += 1; window.removeEventListener(changedEvent, reload.current); window.removeEventListener("focus", reload.current); };
  }, [workspaceId]);
  const scopedPins = useMemo(() => pins.filter((pin) => !peonId || pin.peonId === peonId), [pins, peonId]);
  const isPinned = useCallback((session: SessionLite) => scopedPins.some((pin) => pin.id === session.id && pin.peonId === (session.peonId || peonId)), [scopedPins, peonId]);
  const toggle = async (session: SessionLite) => {
    const peon = session.peonId || peonId;
    if (!workspaceId || !peon) throw new Error("Session workspace is unavailable");
    const current = scope.current;
    const pinned = isPinned(session);
    await api(`/workspaces/${encodeURIComponent(workspaceId)}/session-pins/${encodeURIComponent(peon)}/${encodeURIComponent(session.id)}`, { method: pinned ? "DELETE" : "PUT" });
    if (current !== scope.current) return;
    setPins((items) => pinned ? items.filter((pin) => !(pin.peonId === peon && pin.id === session.id)) : [...items.filter((pin) => !(pin.peonId === peon && pin.id === session.id)), { ...session, peonId: peon }]);
    window.dispatchEvent(new Event(changedEvent));
  };
  return { pins: scopedPins, isPinned, toggle };
}
