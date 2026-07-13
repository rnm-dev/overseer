import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getToken } from "./api";
import { useWorkspace } from "./workspace";

// The single north-bound transport: one WebSocket per app, resumable by cursor.
// Feeds live peons + sessions and bridges live session tails from the peon SSE.
// See app/src/liveSocket.ts for the server side.
// author: Viktor

const DEFAULT_OFFLINE_MS = 45_000;
// Liveness watchdog: ping every PING_MS; if nothing at all arrives for STALE_MS,
// the socket is a zombie (looks OPEN, silently dead — common behind proxies /
// on mobile) so tear it down and resume. STALE_MS allows ~2 missed pongs.
const PING_MS = 10_000;
const STALE_MS = 25_000;

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
  const token = getToken();

  const [connected, setConnected] = useState(false);
  const [peonMap, setPeonMap] = useState<Map<string, PeonView>>(new Map());
  const [sessionMap, setSessionMap] = useState<Map<string, SessionRow>>(new Map());
  const [offlineAfterMs, setOfflineAfterMs] = useState(DEFAULT_OFFLINE_MS);
  const [now, setNow] = useState(() => Date.now());

  const sockRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false); // authenticated workspace snapshot received
  const cursorsRef = useRef<Map<string, number>>(new Map()); // per-workspace resume cursor
  const tailHandlers = useRef<Map<string, { peonId: string; onFrame: (f: TailFrame) => void }>>(new Map());
  // Per-session backoff for tail auto-resubscribe (tailEnd/tailError) — separate
  // from the socket-level backoff so one flaky session tail can't affect others.
  const tailBackoff = useRef<Map<string, number>>(new Map());
  const tailRetryTimers = useRef<Map<string, number>>(new Map());

  // 1s tick so `online` (derived from lastSeen) decays without a server event.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!wsId) {
      readyRef.current = false;
      setConnected(false);
      setPeonMap(new Map());
      setSessionMap(new Map());
      return;
    }
    if (!token) {
      readyRef.current = false;
      setConnected(false);
      setPeonMap(new Map());
      setSessionMap(new Map());
      return;
    }

    let closed = false;
    let retry: number | null = null;
    let backoff = 1000;
    let lastRecvAt = Date.now(); // when we last heard ANYTHING from the server
    let connectStartedAt = 0;
    let lastResumeAt = 0; // debounce gap-resume requests so repeated syncs don't spam
    let connectionGeneration = 0;

    // Fresh workspace ⇒ clear the view until its snapshot lands.
    readyRef.current = false;
    setConnected(false);
    setPeonMap(new Map());
    setSessionMap(new Map());

    const connect = () => {
      if (closed) return;
      // A delayed retry, focus event, and online event can all arrive in the same
      // turn. Only one of them gets to create the next transport.
      const currentSocket = sockRef.current;
      if (currentSocket && (currentSocket.readyState === WebSocket.CONNECTING || currentSocket.readyState === WebSocket.OPEN)) return;
      const url = `${location.origin.replace(/^http/, "ws")}/api/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      const generation = ++connectionGeneration;
      sockRef.current = ws;
      connectStartedAt = Date.now();
      lastRecvAt = Date.now();

      ws.onopen = () => {
        if (closed || sockRef.current !== ws || generation !== connectionGeneration) return ws.close();
        readyRef.current = false;
        lastRecvAt = Date.now();
        ws.send(JSON.stringify({ type: "hello", workspaceId: wsId, cursor: cursorsRef.current.get(wsId) ?? 0 }));
        // A fresh socket supersedes pending per-tail retries. Subscriptions are
        // flushed only after `snapshot`, which is the server's explicit proof that
        // authentication + workspace initialization completed.
        for (const timer of tailRetryTimers.current.values()) window.clearTimeout(timer);
        tailRetryTimers.current.clear();
        tailBackoff.current.clear();
      };
      ws.onclose = () => {
        // A retired socket must never mark its replacement disconnected or arm a
        // second retry. This is especially important after focus/pageshow races.
        if (sockRef.current !== ws || generation !== connectionGeneration) return;
        readyRef.current = false;
        sockRef.current = null;
        setConnected(false);
        if (closed) return;
        if (retry) window.clearTimeout(retry);
        // Jitter prevents every open dashboard reconnecting in lockstep after an
        // overseer/proxy restart.
        const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
        retry = window.setTimeout(() => {
          retry = null;
          connect();
        }, delay);
        backoff = Math.min(backoff * 2, 10_000);
      };
      ws.onerror = () => {
        if (sockRef.current === ws && generation === connectionGeneration) ws.close();
      };
      ws.onmessage = (ev) => {
        if (closed || sockRef.current !== ws || generation !== connectionGeneration) return;
        lastRecvAt = Date.now(); // any frame (incl. pong) proves the link is alive
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "pong") return; // heartbeat ack — liveness already recorded
        handle(msg);
      };
    };

    // Force-replace the current socket immediately (skipping backoff). Detach the
    // old socket's handlers first so a late onclose from the discarded one can't
    // also schedule a competing reconnect.
    const reconnectNow = () => {
      if (closed) return;
      setConnected(false);
      readyRef.current = false;
      const old = sockRef.current;
      if (old) {
        sockRef.current = null;
        old.onopen = old.onclose = old.onerror = old.onmessage = null;
        try {
          old.close();
        } catch {
          /* already closing */
        }
      }
      if (retry) {
        window.clearTimeout(retry);
        retry = null;
      }
      connect();
    };

    const bump = (cursor: unknown) => {
      const c = Number(cursor) || 0;
      if (c > 0) cursorsRef.current.set(wsId, Math.max(c, cursorsRef.current.get(wsId) ?? 0));
    };

    // Gap self-heal: the server's periodic `sync` reports the newest cursor for this
    // workspace. If it's ahead of what we've applied, deltas went missing while the
    // socket stayed open (a live pong can't detect this) — ask to replay the gap
    // over the same socket, no reconnect, no lost tails. Debounced: a resume bumps
    // our cursor, so the next sync sees us caught up; the guard only matters if
    // syncs stack up while a replay is still in flight.
    const requestResume = () => {
      const now = Date.now();
      if (now - lastResumeAt < 3000) return;
      const ws = sockRef.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      lastResumeAt = now;
      ws.send(JSON.stringify({ type: "resume", cursor: cursorsRef.current.get(wsId) ?? 0 }));
    };

    const handle = (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "snapshot": {
          readyRef.current = true;
          setConnected(true);
          // TCP open is not enough to call a connection healthy: auth or the
          // snapshot query can still fail immediately. Reset retry pressure only
          // after the full application handshake succeeds.
          backoff = 1000;
          const peons = (msg.peons as PeonView[]) ?? [];
          const sessions = (msg.sessions as SessionRow[]) ?? [];
          const serverOfflineAfterMs = Number(msg.offlineAfterMs);
          setOfflineAfterMs(Number.isFinite(serverOfflineAfterMs) && serverOfflineAfterMs > 0 ? serverOfflineAfterMs : DEFAULT_OFFLINE_MS);
          setPeonMap(new Map(peons.map((p) => [p.peonId, p])));
          setSessionMap(new Map(sessions.map((s) => [`${s.peonId}:${s.sessionId}`, s])));
          cursorsRef.current.set(wsId, Number(msg.cursor) || 0);
          // `snapshot` is the handshake-ready barrier. Sending subscriptions here
          // (not in onopen) works with slow auth/DB lookups and older servers that
          // did not serialize hello + subscribe messages.
          const ws = sockRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            for (const [sessionId, h] of tailHandlers.current) {
              ws.send(JSON.stringify({ type: "subscribe", peonId: h.peonId, sessionId }));
            }
          }
          break;
        }
        case "resumeEnd": {
          // The server fully drained a frozen replay window. Advancing to its
          // barrier also crosses harmless global-cursor gaps from other workspaces.
          bump(msg.cursor);
          break;
        }
        case "sync": {
          // Server's newest cursor for this workspace — resume if we've fallen behind.
          if ((Number(msg.cursor) || 0) > (cursorsRef.current.get(wsId) ?? 0)) requestResume();
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
        case "tail": {
          const sid = String(msg.sessionId ?? "");
          const handler = tailHandlers.current.get(sid);
          if (!handler || (msg.peonId && msg.peonId !== handler.peonId)) break;
          const timer = tailRetryTimers.current.get(sid);
          if (timer) {
            window.clearTimeout(timer);
            tailRetryTimers.current.delete(sid);
          }
          tailBackoff.current.delete(sid); // live data flowing again — reset backoff
          handler.onFrame({ event: (msg as TailMsg).event ?? null, data: (msg as TailMsg).data ?? "" });
          break;
        }
        case "tailEnd":
        case "tailError": {
          const sid = String(msg.sessionId ?? "");
          const handler = tailHandlers.current.get(sid);
          if (handler && (!msg.peonId || msg.peonId === handler.peonId)) {
            // Old servers emitted tailError immediately followed by tailEnd for the
            // same stream. One pending retry means this terminal generation is
            // already handled; do not notify twice or spawn overlapping timers.
            if (tailRetryTimers.current.has(sid)) break;
            handler.onFrame({ event: msg.type, data: String(msg.error ?? "") });
            if (msg.retryable === false) {
              tailBackoff.current.delete(sid);
              break;
            }
            // A session tail can drop (peon restart, transient network blip) while the
            // session itself is still very much alive — auto-resubscribe with its own
            // backoff so the operator's view self-heals without a full page reload or
            // a full socket reconnect. Stops once the caller unsubscribes (handler removed).
            const delay = tailBackoff.current.get(sid) ?? 1000;
            tailBackoff.current.set(sid, Math.min(delay * 2, 10_000));
            const timer = window.setTimeout(() => {
              tailRetryTimers.current.delete(sid);
              if (tailHandlers.current.get(sid) !== handler) return; // unsubscribed since
              if (readyRef.current && sockRef.current?.readyState === WebSocket.OPEN) sockRef.current.send(JSON.stringify({ type: "subscribe", peonId: handler.peonId, sessionId: sid }));
            }, delay);
            tailRetryTimers.current.set(sid, timer);
          }
          break;
        }
      }
    };

    // Liveness watchdog — the core of "always connected". Every tick: if the socket
    // is open but has heard nothing for STALE_MS it's a zombie (looks alive, silently
    // dead) → replace it; otherwise ping so a healthy link keeps producing traffic.
    // A non-open socket is already handled by onclose's scheduled reconnect.
    const heartbeat = window.setInterval(() => {
      if (closed) return;
      const ws = sockRef.current;
      if (ws?.readyState === WebSocket.CONNECTING) {
        if (Date.now() - connectStartedAt > STALE_MS) reconnectNow();
        return;
      }
      // `close()` starts a handshake that browsers are allowed to leave in
      // CLOSING indefinitely. Waiting only for `onclose` is the classic desktop
      // zombie: no socket, no retry, and updates resume only after F5.
      if (ws?.readyState === WebSocket.CLOSING || ws?.readyState === WebSocket.CLOSED) return reconnectNow();
      if (!ws) {
        if (retry === null) connect();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastRecvAt > STALE_MS) return reconnectNow();
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        reconnectNow();
      }
    }, PING_MS);

    // Recheck the instant connectivity is likely back: the OS reports the network
    // up, or the tab regains focus (a backgrounded/suspended tab is the biggest
    // cause of a zombie socket — timers freeze, so the watchdog above can't fire
    // and the connection may be long dead before onclose ever does). If the socket
    // isn't provably fresh, replace it now instead of waiting for the next tick.
    const kick = () => {
      if (closed) return;
      const ws = sockRef.current;
      if (ws?.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt <= STALE_MS) return;
      if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastRecvAt > PING_MS) return reconnectNow();
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        reconnectNow();
      }
    };
    const onVisible = () => document.visibilityState === "visible" && kick();
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
    window.addEventListener("pageshow", kick); // bfcache restore — timers were frozen
    document.addEventListener("visibilitychange", onVisible);

    connect();
    return () => {
      closed = true;
      readyRef.current = false;
      window.clearInterval(heartbeat);
      window.removeEventListener("online", kick);
      window.removeEventListener("focus", kick);
      window.removeEventListener("pageshow", kick);
      document.removeEventListener("visibilitychange", onVisible);
      if (retry) window.clearTimeout(retry);
      for (const timer of tailRetryTimers.current.values()) window.clearTimeout(timer);
      tailRetryTimers.current.clear();
      tailBackoff.current.clear();
      sockRef.current?.close();
      sockRef.current = null;
    };
  }, [wsId, token]);

  const subscribe = useMemo(
    () => (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void) => {
      const previous = tailHandlers.current.get(sessionId);
      const handler = { peonId, onFrame };
      tailHandlers.current.set(sessionId, handler);
      const timer = tailRetryTimers.current.get(sessionId);
      if (timer) {
        window.clearTimeout(timer);
        tailRetryTimers.current.delete(sessionId);
      }
      tailBackoff.current.delete(sessionId);
      // Only send if the socket is already open; a CONNECTING socket would throw
      // InvalidStateError. The post-handshake snapshot flushes pending subscriptions.
      if (readyRef.current && sockRef.current?.readyState === WebSocket.OPEN) {
        if (previous && previous.peonId !== peonId) sockRef.current.send(JSON.stringify({ type: "unsubscribe", sessionId }));
        sockRef.current.send(JSON.stringify({ type: "subscribe", peonId, sessionId }));
      }
      return () => {
        // An older subscriber cleanup must not delete/unsubscribe a newer handler
        // that reused the same session id.
        if (tailHandlers.current.get(sessionId) !== handler) return;
        tailHandlers.current.delete(sessionId);
        tailBackoff.current.delete(sessionId);
        const timer = tailRetryTimers.current.get(sessionId);
        if (timer) {
          window.clearTimeout(timer);
          tailRetryTimers.current.delete(sessionId);
        }
        if (readyRef.current && sockRef.current?.readyState === WebSocket.OPEN) sockRef.current.send(JSON.stringify({ type: "unsubscribe", sessionId }));
      };
    },
    [],
  );

  // Derive live `online` from lastSeen against the ticking clock.
  const peons = useMemo(
    () => [...peonMap.values()].map((p) => ({ ...p, online: now - (p.lastSeen ?? 0) <= offlineAfterMs })).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [peonMap, now, offlineAfterMs],
  );
  const sessions = useMemo(() => [...sessionMap.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)), [sessionMap]);

  return <Ctx.Provider value={{ connected, peons, sessions, subscribe }}>{children}</Ctx.Provider>;
}

export function useLiveSocket(): LiveSocketValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLiveSocket outside LiveSocketProvider");
  return ctx;
}
