import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getToken } from "./api";
import { useWorkspace } from "./workspace";

// The single north-bound transport: one WebSocket per app, resumable by cursor.
// Feeds live peons + sessions and bridges live session tails from the peon SSE.
// See app/src/liveSocket.ts for the server side.
// author: Viktor

const OFFLINE_MS = 45_000; // mirrors server offlineAfterMs default

export interface PeonView {
  peonId: string;
  name: string | null;
  hostname: string | null;
  baseUrl: string;
  online: boolean;
  lastSeen: number;
  capabilities: string[];
  protocol: number | null;
  load: { activeSessions?: number; paused?: boolean; uptimeSec?: number } | null;
}
export interface SessionRow {
  peonId: string;
  sessionId: string;
  status: string | null;
  title: string | null;
  projectKey: string | null;
  preview: string | null;
  author: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastActivityAt: number | null;
  syncedAt: number;
}
export interface TailFrame {
  event: string | null;
  data: string;
}
type TailMsg = { event?: string | null; data?: string };

interface LiveSocketValue {
  connected: boolean;
  peons: PeonView[];
  sessions: SessionRow[];
  subscribe: (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void) => () => void;
}

const Ctx = createContext<LiveSocketValue | null>(null);

export function LiveSocketProvider({ children }: { children: ReactNode }) {
  const { current } = useWorkspace();
  const wsId = current?.id;

  const [connected, setConnected] = useState(false);
  const [peonMap, setPeonMap] = useState<Map<string, PeonView>>(new Map());
  const [sessionMap, setSessionMap] = useState<Map<string, SessionRow>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  const sockRef = useRef<WebSocket | null>(null);
  const cursorsRef = useRef<Map<string, number>>(new Map()); // per-workspace resume cursor
  const tailHandlers = useRef<Map<string, { peonId: string; onFrame: (f: TailFrame) => void }>>(new Map());

  // 1s tick so `online` (derived from lastSeen) decays without a server event.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!wsId) return;
    const token = getToken();
    if (!token) return;

    let closed = false;
    let retry: number | null = null;
    let backoff = 1000;

    // Fresh workspace ⇒ clear the view until its snapshot lands.
    setPeonMap(new Map());
    setSessionMap(new Map());

    const connect = () => {
      if (closed) return;
      const url = `${location.origin.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      sockRef.current = ws;

      ws.onopen = () => {
        backoff = 1000;
        ws.send(JSON.stringify({ type: "hello", workspaceId: wsId, cursor: cursorsRef.current.get(wsId) ?? 0 }));
        // Re-establish active session tails: covers a subscribe issued while the
        // socket was still CONNECTING, and re-attaches every tail after a reconnect.
        for (const [sessionId, h] of tailHandlers.current) {
          ws.send(JSON.stringify({ type: "subscribe", peonId: h.peonId, sessionId }));
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        handle(msg);
      };
    };

    const bump = (cursor: unknown) => {
      const c = Number(cursor) || 0;
      if (c > 0) cursorsRef.current.set(wsId, Math.max(c, cursorsRef.current.get(wsId) ?? 0));
    };

    const handle = (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "snapshot": {
          setConnected(true);
          const peons = (msg.peons as PeonView[]) ?? [];
          const sessions = (msg.sessions as SessionRow[]) ?? [];
          setPeonMap(new Map(peons.map((p) => [p.peonId, p])));
          setSessionMap(new Map(sessions.map((s) => [`${s.peonId}:${s.sessionId}`, s])));
          cursorsRef.current.set(wsId, Number(msg.cursor) || 0);
          break;
        }
        case "peon": {
          const p = msg.payload as PeonView;
          setPeonMap((prev) => {
            const ex = prev.get(p.peonId);
            if (ex && (p.lastSeen ?? 0) < (ex.lastSeen ?? 0)) return prev; // last-writer-wins
            const next = new Map(prev);
            next.set(p.peonId, p);
            return next;
          });
          bump(msg.cursor);
          break;
        }
        case "session": {
          const s = msg.payload as SessionRow;
          const key = `${s.peonId}:${s.sessionId}`;
          setSessionMap((prev) => {
            const ex = prev.get(key);
            if (ex && (s.syncedAt ?? 0) < (ex.syncedAt ?? 0)) return prev;
            const next = new Map(prev);
            next.set(key, s);
            return next;
          });
          bump(msg.cursor);
          break;
        }
        case "tail":
        case "tailEnd":
        case "tailError": {
          const sid = String(msg.sessionId ?? "");
          const handler = tailHandlers.current.get(sid);
          if (handler) {
            if (msg.type === "tail") handler.onFrame({ event: (msg as TailMsg).event ?? null, data: (msg as TailMsg).data ?? "" });
            else handler.onFrame({ event: msg.type, data: String(msg.error ?? "") });
          }
          break;
        }
      }
    };

    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      sockRef.current?.close();
      sockRef.current = null;
    };
  }, [wsId]);

  const subscribe = useMemo(
    () => (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void) => {
      tailHandlers.current.set(sessionId, { peonId, onFrame });
      // Only send if the socket is already open; a CONNECTING socket would throw
      // InvalidStateError. ws.onopen flushes pending subscriptions either way.
      if (sockRef.current?.readyState === WebSocket.OPEN) sockRef.current.send(JSON.stringify({ type: "subscribe", peonId, sessionId }));
      return () => {
        tailHandlers.current.delete(sessionId);
        if (sockRef.current?.readyState === WebSocket.OPEN) sockRef.current.send(JSON.stringify({ type: "unsubscribe", sessionId }));
      };
    },
    [],
  );

  // Derive live `online` from lastSeen against the ticking clock.
  const peons = useMemo(
    () => [...peonMap.values()].map((p) => ({ ...p, online: now - (p.lastSeen ?? 0) <= OFFLINE_MS })).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [peonMap, now],
  );
  const sessions = useMemo(() => [...sessionMap.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)), [sessionMap]);

  return <Ctx.Provider value={{ connected, peons, sessions, subscribe }}>{children}</Ctx.Provider>;
}

export function useLiveSocket(): LiveSocketValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLiveSocket outside LiveSocketProvider");
  return ctx;
}
