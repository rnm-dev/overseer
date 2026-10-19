import { api } from "../shared/api";
import { audioClientId } from "./audioFocus";

// Framework-free Overseer workspace transport: ws ticket, hello/cursor resume,
// jittered reconnect backoff and a liveness watchdog. Used by the selected
// workspace socket (liveSocket.tsx) and fleet-dashboard sockets (workspaceLive.ts).

// Liveness watchdog: ping every PING_MS; if nothing at all arrives for STALE_MS,
// the socket is a zombie (looks OPEN, silently dead — common behind proxies /
// on mobile) so tear it down and resume. STALE_MS allows ~2 missed pongs.
const PING_MS = 10_000;
const STALE_MS = 25_000;
const MAX_BACKOFF_MS = 10_000;
const RESUME_DEBOUNCE_MS = 3000;

export interface WorkspaceSocketOptions {
  workspaceId: string;
  /** Resume cursor sent with hello / resume. */
  getCursor: () => number;
  /** A new socket opened; hello has not been sent yet. */
  onOpen?: () => void;
  /** Any non-pong frame from the current socket. */
  onMessage: (msg: Record<string, unknown>) => void;
  /** The current socket was lost, replaced, or the transport stopped. */
  onDisconnected?: () => void;
}

export interface WorkspaceSocket {
  /** Sends if the socket is OPEN; returns whether it was sent. */
  send: (message: unknown) => boolean;
  isOpen: () => boolean;
  /** The application handshake succeeded — reset reconnect pressure. */
  resetBackoff: () => void;
  /** Debounced gap replay over the same socket. */
  requestResume: () => void;
  stop: () => void;
}

export function createWorkspaceSocket(options: WorkspaceSocketOptions): WorkspaceSocket {
  const { workspaceId, getCursor, onOpen, onMessage, onDisconnected } = options;
  let socket: WebSocket | null = null;
  let closed = false;
  let retry: number | null = null;
  let backoff = 1000;
  let lastRecvAt = Date.now(); // when we last heard ANYTHING from the server
  let connectStartedAt = 0;
  let lastResumeAt = 0; // debounce gap-resume requests so repeated syncs don't spam
  let ticketPending = false;

  const isOpen = () => socket?.readyState === WebSocket.OPEN;
  const send = (message: unknown) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  const scheduleRetry = (jitter: boolean) => {
    if (retry) window.clearTimeout(retry);
    // Jitter prevents every open dashboard reconnecting in lockstep after an
    // overseer/proxy restart.
    const delay = jitter ? Math.round(backoff * (0.8 + Math.random() * 0.4)) : backoff;
    retry = window.setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const connect = async () => {
    if (closed || ticketPending) return;
    // A delayed retry, focus event, and online event can all arrive in the same
    // turn. Only one of them gets to create the next transport.
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
    ticketPending = true;
    let ticket: string;
    try {
      ({ ticket } = await api<{ ticket: string }>("/auth/ws-ticket", { method: "POST" }));
    } catch {
      ticketPending = false;
      if (!closed && !retry) scheduleRetry(false);
      else backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      return;
    }
    ticketPending = false;
    if (closed) return;
    const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    const current = () => !closed && socket === ws;
    socket = ws;
    connectStartedAt = Date.now();
    lastRecvAt = Date.now();

    ws.onopen = () => {
      if (!current()) return ws.close();
      onOpen?.();
      lastRecvAt = Date.now();
      // clientId travels with hello so every socket of this tab shares one
      // entry in the operator's audio stack.
      ws.send(JSON.stringify({ type: "hello", workspaceId, cursor: getCursor(), clientId: audioClientId() }));
    };
    ws.onclose = () => {
      // A retired socket must never mark its replacement disconnected or arm a
      // second retry. This is especially important after focus/pageshow races.
      if (socket !== ws) return;
      socket = null;
      onDisconnected?.();
      if (closed) return;
      scheduleRetry(true);
    };
    ws.onerror = () => {
      if (socket === ws) ws.close();
    };
    ws.onmessage = (ev) => {
      if (!current()) return;
      lastRecvAt = Date.now(); // any frame (incl. pong) proves the link is alive
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "pong") return; // heartbeat ack — liveness already recorded
      onMessage(msg);
    };
  };

  // Force-replace the current socket immediately (skipping backoff). Detach the
  // old socket's handlers first so a late onclose from the discarded one can't
  // also schedule a competing reconnect.
  const reconnectNow = () => {
    if (closed) return;
    onDisconnected?.();
    const old = socket;
    if (old) {
      socket = null;
      old.onopen = old.onclose = old.onerror = old.onmessage = null;
      old.close();
    }
    if (retry) {
      window.clearTimeout(retry);
      retry = null;
    }
    void connect();
  };

  const ping = () => {
    try {
      socket!.send(JSON.stringify({ type: "ping" }));
    } catch {
      reconnectNow();
    }
  };

  // Liveness watchdog — the core of "always connected". Every tick: if the socket
  // is open but has heard nothing for STALE_MS it's a zombie → replace it;
  // otherwise ping so a healthy link keeps producing traffic.
  const heartbeat = window.setInterval(() => {
    if (closed) return;
    const ws = socket;
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
    if (Date.now() - lastRecvAt > STALE_MS) return reconnectNow();
    ping();
  }, PING_MS);

  // Recheck the instant connectivity is likely back: network up, focus, or a
  // bfcache restore (timers were frozen, the socket may be long dead). If the
  // socket isn't provably fresh, replace it now instead of waiting for a tick.
  const kick = () => {
    if (closed) return;
    const ws = socket;
    if (ws?.readyState === WebSocket.CONNECTING && Date.now() - connectStartedAt <= STALE_MS) return;
    if (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastRecvAt > PING_MS) return reconnectNow();
    ping();
  };
  const onVisible = () => document.visibilityState === "visible" && kick();
  window.addEventListener("online", kick);
  window.addEventListener("focus", kick);
  window.addEventListener("pageshow", kick);
  document.addEventListener("visibilitychange", onVisible);

  void connect();

  return {
    send,
    isOpen,
    resetBackoff: () => {
      backoff = 1000;
    },
    // Gap self-heal: deltas went missing while the socket stayed open — ask to
    // replay the gap over the same socket. Debounced: a resume bumps our cursor,
    // so the guard only matters if syncs stack up while a replay is in flight.
    requestResume: () => {
      const now = Date.now();
      if (now - lastResumeAt < RESUME_DEBOUNCE_MS || !isOpen()) return;
      lastResumeAt = now;
      send({ type: "resume", cursor: getCursor() });
    },
    stop: () => {
      closed = true;
      onDisconnected?.();
      window.clearInterval(heartbeat);
      window.removeEventListener("online", kick);
      window.removeEventListener("focus", kick);
      window.removeEventListener("pageshow", kick);
      document.removeEventListener("visibilitychange", onVisible);
      if (retry) window.clearTimeout(retry);
      socket?.close(1000);
      socket = null;
    },
  };
}
