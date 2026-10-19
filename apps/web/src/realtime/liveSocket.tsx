import { ProjectFileSubscriptions } from "./projectFileSubscriptions";
import { ResourceSubscriptions } from "./resourceSubscriptions";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "../features/workspaces/workspace";
import { useAuth } from "../features/auth/auth";
import { useLocation } from "react-router";
import { presenceLocationForPath, presenceLocationKey, reconcileLocalPresence } from "./presence";
import { setAudioClaimSender, setAudioPrimary } from "./audioFocus";
import { documentPresence } from "../features/sessions/sessionAttentionRead";
import { socketWorkspaceForPath } from "./socketWorkspace";
import { createWorkspaceSocket, type WorkspaceSocket } from "./workspaceSocket";
import { parsePeonProjection, parsePeonProjections } from "../features/workspaces/workspacePeons";

// The selected workspace transport: resumable live events, presence, and session
// tails. Fleet-dashboard workspaces use the same protocol via workspaceLive.ts.
// See apps/server/src/adapters/liveSocket.ts for the server side.
// author: Viktor

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
  projectSessionCounts?: Array<{
    projectId: string | null;
    projectKey: string;
    sessionCount: number;
  }>;
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
export interface MentionAttentionLiveEvent {
  peonId: string;
  sessionId: string;
  eventId: string;
  recipient: { kind: "user" | "guest"; id: string };
  unread: boolean;
  updatedAt: number;
}
type TailMsg = { event?: string | null; id?: string | null; data?: string };
type TailHandler = { peonId: string; onFrame: (f: TailFrame) => void; resumeEnabled: boolean; lastEventId: string | null };
// Fan-out channels: server message type -> payload delivered to subscribers.
interface ChannelEvents {
  session: SessionLiveEvent;
  project: ProjectLiveEvent;
  attention: AttentionLiveEvent;
  mention_attention: MentionAttentionLiveEvent;
}
// Channels whose application the server wants acknowledged via `resource:applied`.
const ACKED_CHANNELS = new Set<keyof ChannelEvents>(["session", "project"]);

interface LiveSocketValue {
  subscribeFiles: ProjectFileSubscriptions["subscribe"];
  subscribeResources: ResourceSubscriptions["subscribe"];
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
  viewersForPeon: (peonId: string) => PresenceUser[];
  viewersForWorkspace: () => PresenceUser[];
  subscribe: (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void, lastEventId?: string | null) => () => void;
  subscribeSessions: (onSession: (session: SessionLiveEvent) => void) => () => void;
  subscribeProjects: (onProject: (project: ProjectLiveEvent) => void) => () => void;
  subscribeAttention: (onAttention: (attention: AttentionLiveEvent) => void) => () => void;
  subscribeMentionAttention: (onAttention: (attention: MentionAttentionLiveEvent) => void) => () => void;
}

const Ctx = createContext<LiveSocketValue | null>(null);

export function LiveSocketProvider({ children }: { children: ReactNode }) {
  const { current, workspaces, peonInventoryReady, workspaceIdOfPeon, updatePeon } = useWorkspace();
  const { user } = useAuth();
  const userEmail = user?.email;
  const { pathname } = useLocation();
  const knownWorkspaceIds = useMemo(() => new Set(workspaces.map((workspace) => workspace.id)), [workspaces]);
  const wsId = socketWorkspaceForPath(
    pathname,
    current?.id,
    knownWorkspaceIds,
    peonInventoryReady,
    workspaceIdOfPeon,
  );
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [acknowledgedPresenceVersion, setAcknowledgedPresenceVersion] = useState(-1);

  const [fileSubscriptions] = useState(() => new ProjectFileSubscriptions());
  const [resourceSubscriptions] = useState(() => new ResourceSubscriptions());
  const sockRef = useRef<WorkspaceSocket | null>(null);
  const readyRef = useRef(false); // authenticated workspace snapshot received
  const cursorsRef = useRef<Map<string, number>>(new Map()); // per-workspace resume cursor
  const tailHandlers = useRef<Map<string, TailHandler>>(new Map());
  const channelHandlers = useRef<{ [K in keyof ChannelEvents]: Set<(event: ChannelEvents[K]) => void> }>({
    session: new Set(),
    project: new Set(),
    attention: new Set(),
    mention_attention: new Set(),
  });
  // Per-session backoff for tail auto-resubscribe (tailEnd/tailError) — separate
  // from the socket-level backoff so one flaky session tail can't affect others.
  const tailBackoff = useRef<Map<string, number>>(new Map());
  const tailRetryTimers = useRef<Map<string, number>>(new Map());

  const clearTailRetry = (sessionId: string) => {
    const timer = tailRetryTimers.current.get(sessionId);
    if (timer) {
      window.clearTimeout(timer);
      tailRetryTimers.current.delete(sessionId);
    }
    tailBackoff.current.delete(sessionId);
  };
  // Only send if the handshake completed; the post-handshake snapshot flushes
  // pending subscriptions.
  const sendReady = (message: unknown) => readyRef.current && (sockRef.current?.send(message) ?? false);
  const sendSubscribe = (sessionId: string, h: TailHandler) =>
    sockRef.current?.send({ type: "subscribe", peonId: h.peonId, sessionId, ...(h.lastEventId ? { lastEventId: h.lastEventId } : {}) });
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
  const desiredPresenceKey = presenceLocationKey(desiredPresence);
  const desiredPresenceVersionRef = useRef({ key: desiredPresenceKey, version: 0 });
  if (desiredPresenceVersionRef.current.key !== desiredPresenceKey) {
    desiredPresenceVersionRef.current = {
      key: desiredPresenceKey,
      version: desiredPresenceVersionRef.current.version + 1,
    };
  }
  const desiredPresenceRef = useRef(desiredPresence);
  desiredPresenceRef.current = desiredPresence;

  useEffect(() => {
    const markDisconnected = () => {
      readyRef.current = false;
      fileSubscriptions.connect(null);
      resourceSubscriptions.connect(null);
    };
    // Fresh workspace (or none) ⇒ clear the view until its snapshot lands.
    markDisconnected();
    setPresence([]);
    if (!wsId || !userEmail) return;
    setAcknowledgedPresenceVersion(-1);

    const acceptPresence = (next: PresenceEntry[]) => {
      setPresence(next);
      const desired = desiredPresenceRef.current;
      if (next.some((entry) =>
        entry.email.toLowerCase() === userEmail.toLowerCase()
        && entry.scope === desired.scope
        && entry.peonId === (desired.peonId ?? null)
        && entry.sessionId === (desired.sessionId ?? null))) {
        setAcknowledgedPresenceVersion(desiredPresenceVersionRef.current.version);
      }
    };

    const getCursor = () => cursorsRef.current.get(wsId) ?? 0;
    const bump = (cursor: unknown) => {
      const c = Number(cursor) || 0;
      if (c > 0) cursorsRef.current.set(wsId, Math.max(c, getCursor()));
    };

    const tailHandlerFor = (msg: Record<string, unknown>) => {
      const sid = String(msg.sessionId ?? "");
      const handler = tailHandlers.current.get(sid);
      if (!handler || (msg.peonId && msg.peonId !== handler.peonId)) return null;
      return { sid, handler };
    };

    const dispatchChannel = <K extends keyof ChannelEvents>(kind: K, msg: Record<string, unknown>) => {
      bump(msg.cursor);
      if (!msg.payload || typeof msg.payload !== "object") return;
      const handlers = channelHandlers.current[kind];
      const applied = handlers.size > 0;
      for (const handler of handlers) handler(msg.payload as ChannelEvents[K]);
      const cursor = Number(msg.cursor) || 0;
      if (ACKED_CHANNELS.has(kind) && applied && cursor > 0) transport.send({ type: "resource:applied", kind, cursor });
    };

    const handle = (msg: Record<string, unknown>) => {
      switch (msg.type) {
        case "files:ready":
        case "files:changed":
        case "files:error":
          fileSubscriptions.handle(msg);
          break;
        case "resources:sample":
        case "resources:error":
          resourceSubscriptions.handle(msg);
          break;
        case "snapshot": {
          readyRef.current = true;
          // TCP open is not enough to call a connection healthy: auth or the
          // snapshot query can still fail immediately. Reset retry pressure only
          // after the full application handshake succeeds.
          transport.resetBackoff();
          acceptPresence((msg.presence as PresenceEntry[]) ?? []);
          for (const peon of parsePeonProjections(msg.peonPresence)) updatePeon(wsId, peon);
          cursorsRef.current.set(wsId, Number(msg.cursor) || 0);
          // `snapshot` is the handshake-ready barrier. Sending subscriptions here
          // (not in onopen) works with slow auth/DB lookups and older servers that
          // did not serialize hello + subscribe messages.
          if (transport.isOpen()) {
            const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
            fileSubscriptions.connect((message) => transport.send(message), capabilities.includes("project-directory-watch-v1"));
            resourceSubscriptions.connect((message) => transport.send(message), capabilities.includes("resource-usage-v1"));
            for (const [sessionId, h] of tailHandlers.current) sendSubscribe(sessionId, h);
            transport.send({ type: "presence:set", ...desiredPresenceRef.current });
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
          if ((Number(msg.cursor) || 0) > getCursor()) transport.requestResume();
          break;
        }
        case "peon": {
          bump(msg.cursor);
          const peon = parsePeonProjection(msg.payload);
          if (peon) updatePeon(wsId, peon);
          const cursor = Number(msg.cursor) || 0;
          if (peon && cursor > 0) transport.send({ type: "resource:applied", kind: "peon", cursor });
          break;
        }
        case "session":
        case "project":
        case "attention":
        case "mention_attention":
          dispatchChannel(msg.type, msg);
          break;
        case "presence": {
          acceptPresence((msg.presence as PresenceEntry[]) ?? []);
          break;
        }
        case "audio": {
          // The overseer's verdict on whether this is the client the operator is
          // using. Everything else stays exactly as it is — only sound is gated.
          setAudioPrimary(msg.primary !== false);
          break;
        }
        case "presenceRetry": {
          window.setTimeout(() => sendReady({ type: "presence:set", ...desiredPresenceRef.current }), 1000);
          break;
        }
        case "tail": {
          const target = tailHandlerFor(msg);
          if (!target) break;
          clearTailRetry(target.sid); // live data flowing again — reset backoff
          const frame = msg as TailMsg;
          const frameId = frame.id ?? null;
          if (target.handler.resumeEnabled && frameId) target.handler.lastEventId = frameId;
          target.handler.onFrame({ event: frame.event ?? null, id: frameId, data: frame.data ?? "" });
          break;
        }
        case "tailReady": {
          const target = tailHandlerFor(msg);
          if (!target) break;
          clearTailRetry(target.sid);
          target.handler.onFrame({ event: "tailReady", id: null, data: "" });
          break;
        }
        case "tailEnd":
        case "tailError": {
          const target = tailHandlerFor(msg);
          if (!target) break;
          const { sid, handler } = target;
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
            if (readyRef.current) sendSubscribe(sid, handler);
          }, delay);
          tailRetryTimers.current.set(sid, timer);
          break;
        }
      }
    };

    const retryTimers = tailRetryTimers.current;
    const tailBackoffs = tailBackoff.current;
    const clearAllTailRetries = () => {
      for (const timer of retryTimers.values()) window.clearTimeout(timer);
      retryTimers.clear();
      tailBackoffs.clear();
    };

    const transport = createWorkspaceSocket({
      workspaceId: wsId,
      getCursor,
      onMessage: handle,
      onDisconnected: markDisconnected,
      // A fresh socket supersedes pending per-tail retries. Subscriptions are
      // flushed only after `snapshot`, which is the server's explicit proof that
      // authentication + workspace initialization completed.
      onOpen: () => {
        markDisconnected();
        clearAllTailRetries();
      },
    });
    sockRef.current = transport;

    // A gesture on this page (starting or stopping a run) claims the sound for
    // this client; the overseer moves it to the top of the operator's stack.
    setAudioClaimSender(() => void sendReady({ type: "audio:claim" }));

    return () => {
      setAudioClaimSender(null);
      transport.stop();
      clearAllTailRetries();
      sockRef.current = null;
    };
  }, [wsId, userEmail, updatePeon, fileSubscriptions, resourceSubscriptions]);

  useEffect(() => {
    sendReady({ type: "presence:set", ...desiredPresence });
  }, [desiredPresence]);

  // Route presence belongs to this socket. Publishing the same route through an
  // independent HTTP heartbeat creates a second server-side connectionId; while
  // navigating, those two entries can briefly point at the old and new sessions.
  // The socket heartbeat above already keeps this authoritative entry alive.

  const subscribe = useMemo(
    () => (peonId: string, sessionId: string, onFrame: (f: TailFrame) => void, lastEventId?: string | null) => {
      const previous = tailHandlers.current.get(sessionId);
      const handler: TailHandler = { peonId, onFrame, resumeEnabled: lastEventId !== undefined, lastEventId: lastEventId ?? null };
      tailHandlers.current.set(sessionId, handler);
      clearTailRetry(sessionId);
      if (readyRef.current && sockRef.current?.isOpen()) {
        if (previous && previous.peonId !== peonId) sockRef.current.send({ type: "unsubscribe", sessionId });
        sendSubscribe(sessionId, handler);
      }
      return () => {
        // An older subscriber cleanup must not delete/unsubscribe a newer handler
        // that reused the same session id.
        if (tailHandlers.current.get(sessionId) !== handler) return;
        tailHandlers.current.delete(sessionId);
        clearTailRetry(sessionId);
        sendReady({ type: "unsubscribe", sessionId });
      };
    },
    [],
  );

  const channelSubscribers = useMemo(() => {
    const subscriber = <K extends keyof ChannelEvents>(kind: K) => (handler: (event: ChannelEvents[K]) => void) => {
      const handlers = channelHandlers.current[kind] as Set<(event: ChannelEvents[K]) => void>;
      handlers.add(handler);
      return () => void handlers.delete(handler);
    };
    return {
      subscribeSessions: subscriber("session"),
      subscribeProjects: subscriber("project"),
      subscribeAttention: subscriber("attention"),
      subscribeMentionAttention: subscriber("mention_attention"),
    };
  }, []);

  const withLocalUser = useMemo(() => {
    const localUser: PresenceUser | null = user ? {
      userId: `self:${user.email}`,
      email: user.email,
      githubLogin: user.githubLogin ?? null,
      avatarUrl: user.avatarUrl ?? null,
    } : null;
    return (entries: PresenceUser[], matchesLocal: boolean): PresenceUser[] =>
      reconcileLocalPresence(
        entries,
        localUser,
        matchesLocal,
        acknowledgedPresenceVersion !== desiredPresenceVersionRef.current.version,
      );
  }, [acknowledgedPresenceVersion, user]);

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

  const value = useMemo<LiveSocketValue>(() => ({
    subscribeFiles: fileSubscriptions.subscribe,
    subscribeResources: resourceSubscriptions.subscribe,
    viewersFor,
    viewersForPeon,
    viewersForWorkspace,
    subscribe,
    ...channelSubscribers,
  }), [fileSubscriptions, resourceSubscriptions, viewersFor, viewersForPeon, viewersForWorkspace, subscribe, channelSubscribers]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLiveSocket(): LiveSocketValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLiveSocket outside LiveSocketProvider");
  return ctx;
}
