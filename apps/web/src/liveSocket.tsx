import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, json } from "./api";
import { useWorkspace } from "./workspace";
import { useAuth } from "./auth";
import { useLocation } from "react-router";
import { presenceLocationForPath } from "./presence";
import { audioClientId, setAudioClaimSender, setAudioPrimary } from "./audioFocus";
import { documentPresence } from "./pages/peon/sessionAttentionRead";
import { parsePeonProjection, parsePeonProjections } from "./workspacePeons";

// The selected workspace transport: resumable live events, presence, and session
// tails. Fleet-dashboard workspaces use the same protocol via workspaceLive.ts.
// See app/src/liveSocket.ts for the server side.
// author: Viktor

// Liveness watchdog: ping every PING_MS; if nothing at all arrives for STALE_MS,
// the socket is a zombie (looks OPEN, silently dead — common behind proxies /
// on mobile) so tear it down and resume. STALE_MS allows ~2 missed pongs.
const PING_MS = 10_000;
const STALE_MS = 25_000;

export interface TailFrame {
  event: string | null;
  id: string | null;
  data: string;
}
export interface PresenceUser {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}
export interface PresenceEntry extends PresenceUser {
  scope: "workspace" | "peon" | "session";
  peonId: string | null;
  sessionId: string | null;
}
export interface SessionLiveEvent {
  peonId?: string;
  sessionId?: string;
  deleted?: boolean;
  syncedAt?: number;
  [key: string]: unknown;
}
export interface ProjectLiveEvent {
  peonId: string;
  projectId: string;
  key?: string;
  deleted?: boolean;
  syncedAt: number;
  [key: string]: unknown;
}
export interface AttentionLiveEvent {
  peonId: string;
  sessionId: string;
  unread: boolean;
  completedAt?: number | null;
  updatedAt: number;
}
type TailMsg = { event?: string | null; id?: string | null; data?: string };

interface LiveSocketValue {
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
  viewersForPeon: (peonId: string) => PresenceUser[];
  viewersForWorkspace: () => PresenceUser[];
  subscribe: (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void, lastEventId?: string | null) => () => void;
  subscribeSessions: (onSession: (session: SessionLiveEvent) => void) => () => void;
  subscribeProjects: (onProject: (project: ProjectLiveEvent) => void) => () => void;
  subscribeAttention: (onAttention: (attention: AttentionLiveEvent) => void) => () => void;
}

const Ctx = createContext<LiveSocketValue | null>(null);

export function LiveSocketProvider({ children }: { children: ReactNode }) {
  const { current, updatePeon } = useWorkspace();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const wsId = current?.id;
  const [presence, setPresence] = useState<PresenceEntry[]>([]);

  const sockRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false); // authenticated workspace snapshot received
  const cursorsRef = useRef<Map<string, number>>(new Map()); // per-workspace resume cursor
  const tailHandlers = useRef<Map<string, { peonId: string; onFrame: (f: TailFrame) => void; resumeEnabled: boolean; lastEventId: string | null }>>(new Map());
  const sessionHandlers = useRef<Set<(session: SessionLiveEvent) => void>>(new Set());
  const projectHandlers = useRef<Set<(project: ProjectLiveEvent) => void>>(new Set());
  const attentionHandlers = useRef<Set<(attention: AttentionLiveEvent) => void>>(new Set());
  // Per-session backoff for tail auto-resubscribe (tailEnd/tailError) — separate
  // from the socket-level backoff so one flaky session tail can't affect others.
  const tailBackoff = useRef<Map<string, number>>(new Map());
  const tailRetryTimers = useRef<Map<string, number>>(new Map());
  const routePresence = useMemo(() => presenceLocationForPath(pathname), [pathname]);
  // The route says where the operator is; documentPresence says whether they are
  // actually looking. Both travel with presence so the server can tell a watched
  // session from a backgrounded tab.
  const [presenceActive, setPresenceActive] = useState(() => documentPresence(document));
  useEffect(() => {
    const sync = () => setPresenceActive(documentPresence(document));
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
  const desiredPresence = useMemo(() => ({ ...routePresence, active: presenceActive }), [routePresence, presenceActive]);
  const desiredPresenceRef = useRef(desiredPresence);
  desiredPresenceRef.current = desiredPresence;

  useEffect(() => {
    if (!wsId) {
      readyRef.current = false;
      setPresence([]);
      return;
    }
    if (!user) {
      readyRef.current = false;
      setPresence([]);
      return;
    }

    let closed = false;
    let retry: number | null = null;
    let backoff = 1000;
    let lastRecvAt = Date.now(); // when we last heard ANYTHING from the server
    let connectStartedAt = 0;
    let lastResumeAt = 0; // debounce gap-resume requests so repeated syncs don't spam
    let connectionGeneration = 0;
    let ticketPending = false;

    // Fresh workspace ⇒ clear the view until its snapshot lands.
    readyRef.current = false;
    setPresence([]);

    const connect = async () => {
      if (closed || ticketPending) return;
      // A delayed retry, focus event, and online event can all arrive in the same
      // turn. Only one of them gets to create the next transport.
      const currentSocket = sockRef.current;
      if (currentSocket && (currentSocket.readyState === WebSocket.CONNECTING || currentSocket.readyState === WebSocket.OPEN)) return;
      ticketPending = true;
      let ticket: string;
      try {
        ({ ticket } = await api<{ ticket: string }>("/auth/ws-ticket", { method: "POST" }));
      } catch {
        ticketPending = false;
        if (!closed && !retry) retry = window.setTimeout(() => { retry = null; void connect(); }, backoff);
        backoff = Math.min(backoff * 2, 10_000);
        return;
      }
      ticketPending = false;
      if (closed) return;
      const url = `${location.origin.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      const generation = ++connectionGeneration;
      sockRef.current = ws;
      connectStartedAt = Date.now();
      lastRecvAt = Date.now();

      ws.onopen = () => {
        if (closed || sockRef.current !== ws || generation !== connectionGeneration) return ws.close();
        readyRef.current = false;
        lastRecvAt = Date.now();
        // clientId travels with hello so every socket of this tab shares one
        // entry in the operator's audio stack.
        ws.send(JSON.stringify({ type: "hello", workspaceId: wsId, cursor: cursorsRef.current.get(wsId) ?? 0, clientId: audioClientId() }));
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
        if (closed) return;
        if (retry) window.clearTimeout(retry);
        // Jitter prevents every open dashboard reconnecting in lockstep after an
        // overseer/proxy restart.
        const delay = Math.round(backoff * (0.8 + Math.random() * 0.4));
        retry = window.setTimeout(() => {
          retry = null;
          void connect();
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
      void connect();
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
          // TCP open is not enough to call a connection healthy: auth or the
          // snapshot query can still fail immediately. Reset retry pressure only
          // after the full application handshake succeeds.
          backoff = 1000;
          const presence = (msg.presence as PresenceEntry[]) ?? [];
          setPresence(presence);
          for (const peon of parsePeonProjections(msg.peonPresence)) updatePeon(wsId, peon);
          cursorsRef.current.set(wsId, Number(msg.cursor) || 0);
          // `snapshot` is the handshake-ready barrier. Sending subscriptions here
          // (not in onopen) works with slow auth/DB lookups and older servers that
          // did not serialize hello + subscribe messages.
          const ws = sockRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            for (const [sessionId, h] of tailHandlers.current) {
              ws.send(JSON.stringify({ type: "subscribe", peonId: h.peonId, sessionId, ...(h.lastEventId ? { lastEventId: h.lastEventId } : {}) }));
            }
            ws.send(JSON.stringify({ type: "presence:set", ...desiredPresenceRef.current }));
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
          bump(msg.cursor);
          const peon = parsePeonProjection(msg.payload);
          if (peon) updatePeon(wsId, peon);
          break;
        }
        case "session": {
          bump(msg.cursor);
          if (msg.payload && typeof msg.payload === "object") {
            for (const onSession of sessionHandlers.current) onSession(msg.payload as SessionLiveEvent);
          }
          break;
        }
        case "project": {
          bump(msg.cursor);
          if (msg.payload && typeof msg.payload === "object") {
            for (const onProject of projectHandlers.current) onProject(msg.payload as ProjectLiveEvent);
          }
          break;
        }
        case "attention": {
          bump(msg.cursor);
          if (msg.payload && typeof msg.payload === "object") {
            for (const onAttention of attentionHandlers.current) onAttention(msg.payload as AttentionLiveEvent);
          }
          break;
        }
        case "presence": {
          setPresence((msg.presence as PresenceEntry[]) ?? []);
          break;
        }
        case "audio": {
          // The overseer's verdict on whether this is the client the operator is
          // using. Everything else stays exactly as it is — only sound is gated.
          setAudioPrimary(msg.primary !== false);
          break;
        }
        case "presenceRetry": {
          window.setTimeout(() => {
            if (readyRef.current && sockRef.current?.readyState === WebSocket.OPEN) {
              sockRef.current.send(JSON.stringify({ type: "presence:set", ...desiredPresenceRef.current }));
            }
          }, 1000);
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
          const frameId = (msg as TailMsg).id ?? null;
          if (handler.resumeEnabled && frameId) handler.lastEventId = frameId;
          handler.onFrame({ event: (msg as TailMsg).event ?? null, id: frameId, data: (msg as TailMsg).data ?? "" });
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
            handler.onFrame({ event: msg.type, id: null, data: String(msg.error ?? "") });
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
              if (readyRef.current && sockRef.current?.readyState === WebSocket.OPEN) sockRef.current.send(JSON.stringify({ type: "subscribe", peonId: handler.peonId, sessionId: sid, ...(handler.lastEventId ? { lastEventId: handler.lastEventId } : {}) }));
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
        if (retry === null) void connect();
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
    const retryTimers = tailRetryTimers.current;
    const tailBackoffs = tailBackoff.current;
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
    window.addEventListener("pageshow", kick); // bfcache restore — timers were frozen
    document.addEventListener("visibilitychange", onVisible);

    // A gesture on this page (starting or stopping a run) claims the sound for
    // this client; the overseer moves it to the top of the operator's stack.
    setAudioClaimSender(() => {
      const ws = sockRef.current;
      if (readyRef.current && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "audio:claim" }));
    });

    void connect();
    return () => {
      closed = true;
      readyRef.current = false;
      setAudioClaimSender(null);
      window.clearInterval(heartbeat);
      window.removeEventListener("online", kick);
      window.removeEventListener("focus", kick);
      window.removeEventListener("pageshow", kick);
      document.removeEventListener("visibilitychange", onVisible);
      if (retry) window.clearTimeout(retry);
      for (const timer of retryTimers.values()) window.clearTimeout(timer);
      retryTimers.clear();
      tailBackoffs.clear();
      sockRef.current?.close();
      sockRef.current = null;
    };
  }, [wsId, user, updatePeon]);

  useEffect(() => {
    const ws = sockRef.current;
    if (readyRef.current && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "presence:set", ...desiredPresence }));
    }
  }, [desiredPresence]);

  // Independent route heartbeat: keeps presence accurate when a browser/proxy
  // has a wedged WebSocket but ordinary authenticated HTTP still works.
  useEffect(() => {
    if (!wsId || !user) return;
    const connectionId = crypto.randomUUID();
    let stopped = false;
    const beat = () => {
      if (stopped) return;
      void api<{ presence: PresenceEntry[] }>(`/workspaces/${wsId}/presence`, json({ connectionId, ...desiredPresence }))
        .then((result) => {
          if (!stopped) setPresence(result.presence ?? []);
        })
        .catch(() => undefined);
    };
    const clear = () => {
      void api(`/workspaces/${wsId}/presence`, { ...json({ connectionId }), method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 10_000);
    window.addEventListener("focus", beat);
    window.addEventListener("pagehide", clear);
    document.addEventListener("visibilitychange", beat);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", beat);
      window.removeEventListener("pagehide", clear);
      document.removeEventListener("visibilitychange", beat);
      clear();
    };
  }, [desiredPresence, user, wsId]);

  const subscribe = useMemo(
    () => (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void, lastEventId?: string | null) => {
      const previous = tailHandlers.current.get(sessionId);
      const handler = { peonId, onFrame, resumeEnabled: lastEventId !== undefined, lastEventId: lastEventId ?? null };
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
        sockRef.current.send(JSON.stringify({ type: "subscribe", peonId, sessionId, ...(handler.lastEventId ? { lastEventId: handler.lastEventId } : {}) }));
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

  const subscribeSessions = useMemo(() => (onSession: (session: SessionLiveEvent) => void) => {
    sessionHandlers.current.add(onSession);
    return () => sessionHandlers.current.delete(onSession);
  }, []);

  const subscribeProjects = useMemo(() => (onProject: (project: ProjectLiveEvent) => void) => {
    projectHandlers.current.add(onProject);
    return () => projectHandlers.current.delete(onProject);
  }, []);

  const subscribeAttention = useMemo(() => (onAttention: (attention: AttentionLiveEvent) => void) => {
    attentionHandlers.current.add(onAttention);
    return () => attentionHandlers.current.delete(onAttention);
  }, []);

  const withLocalUser = useMemo(() => (entries: PresenceUser[], matchesLocal: boolean): PresenceUser[] => {
    const viewers = uniqueUsers(entries);
    if (!user || !matchesLocal || viewers.some((viewer) => viewer.email === user.email)) return viewers;
    return [{ userId: `self:${user.email}`, email: user.email, githubLogin: user.githubLogin ?? null, avatarUrl: user.avatarUrl ?? null }, ...viewers];
  }, [user]);

  const viewersFor = useMemo(() => (peonId: string, sessionId: string) => withLocalUser(
    presence.filter((entry) => entry.scope === "session" && entry.peonId === peonId && entry.sessionId === sessionId),
    desiredPresence.scope === "session" && desiredPresence.peonId === peonId && desiredPresence.sessionId === sessionId,
  ), [desiredPresence, presence, withLocalUser]);

  const viewersForPeon = useMemo(() => (peonId: string) => {
    return withLocalUser(
      presence.filter((entry) => entry.peonId === peonId),
      desiredPresence.peonId === peonId,
    );
  }, [desiredPresence.peonId, presence, withLocalUser]);

  const viewersForWorkspace = useMemo(() => () => withLocalUser(presence, true), [presence, withLocalUser]);

  return <Ctx.Provider value={{ viewersFor, viewersForPeon, viewersForWorkspace, subscribe, subscribeSessions, subscribeProjects, subscribeAttention }}>{children}</Ctx.Provider>;
}

function uniqueUsers(entries: PresenceUser[]): PresenceUser[] {
  const users = new Map<string, PresenceUser>();
  for (const entry of entries) {
    const key = entry.email.toLowerCase();
    if (!users.has(key)) users.set(key, entry);
  }
  return [...users.values()].sort((a, b) => (a.githubLogin || a.email).localeCompare(b.githubLogin || b.email));
}

export function useLiveSocket(): LiveSocketValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLiveSocket outside LiveSocketProvider");
  return ctx;
}
