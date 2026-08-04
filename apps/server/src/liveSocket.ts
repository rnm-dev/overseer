import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { consumeWebSocketTicket } from "./modules/auth/index.js";
import { membership, type Role } from "./workspaces.js";
import { registry, toView } from "./registry.js";
import { getIndexedSession } from "./sessionIndex.js";
import { bus, latestCursor, oldestCursor, readEventsSince, type LiveEvent } from "./eventLog.js";
import { callPeon, connOfRecord, streamPeonTo } from "./infrastructure/peonHttp/index.js";
import { eventVisible, peonVisible, projectVisible, refreshClientAccess, sessionVisible } from "./liveAccess.js";
import {
  audioFocusBus,
  claimAudioFocus,
  hasAudioFocus,
  heartbeatPresence,
  listHeartbeatPresence,
  presenceBus,
  promoteAudioFocus,
  releaseAudioFocus,
  removePresence,
  setAudioFocusActive,
  touchPresence,
} from "./modules/presence/index.js";
import {
  getTranscriptState,
  readTranscriptAfter,
} from "./modules/sessions/index.js";
import {
  acquireTranscriptProjection,
  hasReverseTranscriptConnection,
  transcriptConnectionBus,
} from "./peonTranscriptSync.js";
import { canAccessIndexedSessionNow } from "./access.js";
import { enrichLiveTranscriptEvent } from "./transcriptTimestamps.js";

// The north-bound (overseer→client) transport: one authenticated WebSocket per
// app, multiplexing presence + live session tails, resumable by cursor.
//   client → { type:"hello", workspaceId, cursor? }
//   server → { type:"snapshot", presence, peonPresence, cursor } then replays events>cursor, then live
//   client → { type:"subscribe"|"unsubscribe", peonId, sessionId }
//   server → { type:"tail", sessionId, event, id, data }   (bridged from the peon SSE)
//   client → { type:"audio:claim"|"audio:release" }   — operator is / is not here
//   server → { type:"audio", primary }  — may this client play notification sound
//
// Audio ownership: an operator with a desktop window and a phone open must hear
// a finished run once, on the app they last picked up. hello carries a clientId
// (per browser tab, per install on a native app), the sockets of one client share
// one entry in the operator's stack (modules/presence/audioFocus), and only the
// top entry is told primary:true. A client that sends no clientId stays out of
// the stack: it keeps the old always-play behavior and cannot mute anyone else.
//
// Live self-heal: the server periodically pushes { type:"sync", cursor } — the
// latest cursor for the client's workspace. The client compares it to what it has
// actually applied and, if it's behind, asks to { type:"resume", cursor } to
// replay the gap. This closes the one hole a ping/pong watchdog can't see: a
// socket that's still open and still answers pings but has silently stopped
// receiving event deltas (a wedged fan-out, a proxy that drops frames one-way).
// A live pong proves the socket is alive; a sync proves you're caught up.
// author: Viktor

interface Client {
  presenceConnectionId: string;
  ws: WebSocket;
  userId: string;
  actor: string;
  identity: PresenceUser;
  workspaceId: string | null;
  role: Role | null;
  allowedPeons: Set<string> | null;
  allowedProjects: Map<string, Set<string>> | null;
  live: boolean;
  alive: boolean;
  closed: boolean;
  queuedMessages: number;
  messageQueue: Promise<void>;
  tails: Map<string, AbortController>;
  location: PresenceLocation | null;
  // Whether that location is actually in front of the operator (tab visible +
  // focused). A backgrounded tab keeps its place in the viewer list but must not
  // count as "seen" for session attention.
  presenceActive: boolean;
  // The tab this socket belongs to, for audio ownership. Null until hello.
  audioClientId: string | null;
  // Last `primary` value sent, so a recompute only speaks when it has news.
  audioPrimary: boolean | null;
  // Publishes audio ownership to every socket of this client's operator.
  syncAudio: () => void;
}

interface PresenceUser {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}

interface PresenceLocation {
  scope: "workspace" | "peon" | "session";
  peonId: string | null;
  sessionId: string | null;
  projectKey: string | null;
  projectId: string | null;
}

interface PresenceEntry extends PresenceUser {
  scope: PresenceLocation["scope"];
  peonId: string | null;
  sessionId: string | null;
}

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_AUTH_MESSAGES = 32;
const MAX_QUEUED_MESSAGES = 256;
const REPLAY_PAGE_SIZE = 1000;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_TRANSCRIPT_EVENTS = 1_000;
const MAX_PENDING_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

interface ReverseTailState {
  peonId: string;
  sessionId: string;
  ready: boolean;
  pending: LiveEvent[];
  pendingBytes: number;
  seen: Set<string>;
  release: (() => void) | null;
  delivery: Promise<void>;
}

const reverseTails = new WeakMap<AbortController, ReverseTailState>();

export const send = (ws: WebSocket, msg: unknown): boolean => {
  if (ws.readyState !== WebSocket.OPEN) return false;
  // A slow/backgrounded browser must not turn an unbounded tail into server-side
  // memory growth. Terminating is safe: durable state resumes by cursor and the
  // session tail reattaches on the fresh socket.
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.terminate();
    return false;
  }
  try {
    ws.send(JSON.stringify(msg), (err) => {
      if (err && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    });
    return true;
  } catch {
    ws.terminate();
    return false;
  }
};

export function attachLiveSocket(server: Server): WebSocketServer {
  // Route upgrades explicitly. WebSocketServer's `{ server, path }` mode installs
  // a catch-all upgrade listener that responds 400 to every other path. That
  // races the independently authenticated Peon socket attached to this same
  // HTTP server and rejects it before its async credential lookup can finish.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? "", "http://overseer.local").pathname;
    if (path !== "/api/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);
  const clients = new Set<Client>();
  // Tell each of an operator's sockets whether its tab currently owns audio.
  // Ownership is per operator, not per workspace, so this deliberately ignores
  // which workspace a socket is looking at.
  const syncAudio = (userId: string) => {
    for (const c of clients) {
      if (c.userId !== userId || !c.audioClientId) continue;
      const primary = hasAudioFocus(userId, c.audioClientId);
      if (primary === c.audioPrimary) continue;
      c.audioPrimary = primary;
      send(c.ws, { type: "audio", primary });
    }
  };
  // Latest appended (cursor>0) event cursor per workspace, kept in memory from the
  // bus. It's the yardstick the periodic sync hands each client so it can tell
  // whether it's caught up. Absent (process just booted, no events yet) ⇒ 0, which
  // never triggers a spurious resume (0 is never ahead of a client's cursor).
  const wsCursor = new Map<string, number>();

  wss.on("connection", (ws, req) => {
    const ticket = new URL(req.url ?? "", "http://x").searchParams.get("ticket");
    let client: Client | null = null;
    let disconnected = false;
    const pending: string[] = [];

    // Install listeners before the asynchronous credential lookup. Browsers send
    // `hello` immediately from onopen; attaching this listener afterwards loses
    // that first frame nondeterministically on a fast network / slow database.
    ws.on("pong", () => {
      if (client) client.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text frames only");
      const raw = data.toString();
      if (client) return enqueueMessage(client, raw, wsCursor);
      if (pending.length >= MAX_PENDING_AUTH_MESSAGES) return ws.close(1008, "too many pre-auth messages");
      pending.push(raw);
    });
    ws.on("close", () => {
      disconnected = true;
      if (!client) return;
      const workspaceId = client.workspaceId;
      client.closed = true;
      for (const c of client.tails.values()) c.abort();
      client.tails.clear();
      client.location = null;
      clients.delete(client);
      if (workspaceId) removePresence(workspaceId, client.userId, client.presenceConnectionId);
      // Popping this tab off the audio stack promotes whatever was underneath —
      // the desktop window that stayed connected while the phone came and went.
      if (client.audioClientId) releaseAudioFocus(client.userId, client.audioClientId, client.presenceConnectionId);
    });
    ws.on("error", () => {});

    void (async () => {
      let auth: Awaited<ReturnType<typeof consumeWebSocketTicket>>;
      try {
        auth = ticket ? await consumeWebSocketTicket(ticket) : null;
      } catch {
        if (!disconnected) ws.close(1011, "authentication unavailable");
        return;
      }
      if (disconnected || ws.readyState !== WebSocket.OPEN) return;
      if (!auth) return ws.close(4401, "unauthorized");

      client = {
        presenceConnectionId: `ws:${randomUUID()}`,
        ws,
        userId: auth.userId,
        actor: auth.email,
        identity: { userId: auth.userId, email: auth.email, githubLogin: auth.githubLogin, avatarUrl: auth.avatarUrl },
        workspaceId: null,
        role: null,
        allowedPeons: null,
        allowedProjects: null,
        live: false,
        alive: true,
        closed: false,
        queuedMessages: 0,
        messageQueue: Promise.resolve(),
        tails: new Map(),
        location: null,
        presenceActive: true,
        audioClientId: null,
        audioPrimary: null,
        syncAudio: () => syncAudio(auth.userId),
      };
      clients.add(client);
      for (const raw of pending) enqueueMessage(client, raw, wsCursor);
      pending.length = 0;
    })();
  });

  // Live fan-out — every appended/broadcast event to matching, caught-up clients.
  const onBusEvent = (e: LiveEvent) => {
    // Track the workspace high-water cursor (durable events only; cursor:0
    // broadcasts are liveness the client re-derives, never a resume target).
    if (e.cursor > 0) wsCursor.set(e.workspaceId, Math.max(e.cursor, wsCursor.get(e.workspaceId) ?? 0));
    for (const c of clients) {
      // Peon connection presence is ephemeral and has no replay cursor. Let it
      // pass while the initial materialized snapshot is being assembled so a
      // connect/disconnect in that window cannot be lost. Durable events remain
      // gated until snapshotAndReplay establishes its cursor barrier.
      const presenceDuringSnapshot = e.cursor === 0 && e.kind === "peon";
      if (e.kind === "transcript") {
        if (!c.live || c.workspaceId !== e.workspaceId || !e.sessionId) continue;
        const controller = c.tails.get(e.sessionId);
        const tail = controller ? reverseTails.get(controller) : null;
        if (!tail || tail.peonId !== e.peonId) continue;
        if (!tail.ready) {
          const bytes = Buffer.byteLength(JSON.stringify(e.payload));
          if (tail.pending.length >= MAX_PENDING_TRANSCRIPT_EVENTS
            || tail.pendingBytes + bytes > MAX_PENDING_TRANSCRIPT_BYTES) {
            controller!.abort();
            c.tails.delete(e.sessionId);
            send(c.ws, {
              type: "tailError",
              peonId: e.peonId,
              sessionId: e.sessionId,
              error: "transcript browser buffer exceeded",
            });
            continue;
          }
          tail.pending.push(e);
          tail.pendingBytes += bytes;
          continue;
        }
        tail.delivery = tail.delivery
          .then(async () => {
            await deliverProjectedTail(c, controller!, tail, e);
          })
          .catch(() => closeRevokedTail(c, controller!, tail));
        continue;
      }
      if ((c.live || presenceDuringSnapshot) && c.workspaceId === e.workspaceId && eventVisible(c, e)) {
        send(c.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
      }
    }
  };
  bus.on("event", onBusEvent);
  const onPresenceChange = (workspaceId: string) => broadcastPresence(clients, workspaceId);
  presenceBus.on("changed", onPresenceChange);
  const onAudioFocusChange = (userId: string) => syncAudio(userId);
  audioFocusBus.on("changed", onAudioFocusChange);
  const onTranscriptConnection = (peonId: string, connected: boolean) => {
    if (connected) return;
    for (const client of clients) {
      for (const [sessionId, controller] of client.tails) {
        const tail = reverseTails.get(controller);
        if (!tail || tail.peonId !== peonId) continue;
        controller.abort();
        client.tails.delete(sessionId);
        send(client.ws, {
          type: "tailError",
          peonId,
          sessionId,
          error: "reverse transcript connection closed",
        });
      }
    }
  };
  transcriptConnectionBus.on("changed", onTranscriptConnection);

  // Cursor sync — refresh high-water marks from Postgres, not only the local bus.
  // That makes self-heal work across multiple overseer processes and after any
  // missed in-process fan-out. One slow DB round cannot stack another interval.
  let syncRunning = false;
  const sync = setInterval(() => {
    if (syncRunning) return;
    const workspaces = [...new Set([...clients].flatMap((client) => client.live && client.workspaceId ? [client.workspaceId] : []))];
    if (workspaces.length === 0) return;
    syncRunning = true;
    void Promise.all(workspaces.map(async (workspaceId) => {
      try {
        const cursor = await latestCursor(workspaceId);
        wsCursor.set(workspaceId, Math.max(cursor, wsCursor.get(workspaceId) ?? 0));
      } catch {
        // Cached bus high-water remains useful during a transient DB failure.
      }
    })).finally(() => {
      void Promise.all([...clients].map(async (client) => {
        await refreshClientAccess(client);
        const location = client.location;
        if (!location?.peonId) return;
        if (!peonVisible(client, location.peonId)
          || (location.scope === "session" && !sessionVisible(client, location.peonId, location.projectKey, location.projectId))) {
          client.location = null;
          if (client.workspaceId) removePresence(client.workspaceId, client.userId, client.presenceConnectionId);
        }
      })).finally(() => {
        for (const workspaceId of workspaces) broadcastPresence(clients, workspaceId);
        for (const client of clients) {
          if (client.live && client.workspaceId) send(client.ws, { type: "sync", cursor: wsCursor.get(client.workspaceId) ?? 0 });
        }
      });
      syncRunning = false;
    });
  }, 15_000);

  // Ping/pong reaper — drop sockets that miss a round (dead mobile connections).
  const ping = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* terminating */
      }
    }
  }, 30_000);
  wss.on("close", () => {
    clearInterval(sync);
    clearInterval(ping);
    bus.off("event", onBusEvent);
    presenceBus.off("changed", onPresenceChange);
    audioFocusBus.off("changed", onAudioFocusChange);
    transcriptConnectionBus.off("changed", onTranscriptConnection);
    server.off("upgrade", onUpgrade);
  });
  return wss;
}

function enqueueMessage(client: Client, raw: string, wsCursor: Map<string, number>): void {
  client.alive = true;
  if (client.queuedMessages >= MAX_QUEUED_MESSAGES) {
    client.ws.close(1008, "too many queued messages");
    return;
  }
  client.queuedMessages += 1;
  client.messageQueue = client.messageQueue
    .then(() => client.closed ? undefined : onMessage(client, raw, wsCursor))
    .catch(() => {
      // Reset through a clean reconnect instead of leaving a half-applied hello,
      // resume, or subscription mutation on this client.
      if (!client.closed && client.ws.readyState === WebSocket.OPEN) client.ws.close(1011, "live update failed");
    })
    .finally(() => {
      client.queuedMessages -= 1;
    });
}

async function onMessage(client: Client, raw: string, wsCursor: Map<string, number>): Promise<void> {
  let msg: { type?: string; workspaceId?: string; cursor?: number; scope?: string; peonId?: string; sessionId?: string; lastEventId?: string; clientId?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  // App-level heartbeat: the client pings to prove the link is alive (the browser
  // never surfaces WS-level pong frames to JS, so it can't rely on those). Answer
  // immediately — a healthy connection then always sees inbound traffic, and the
  // client's watchdog tears down + resumes a socket that's gone silent.
  if (msg.type === "ping") {
    if (client.workspaceId) touchPresence(client.workspaceId, client.userId, client.presenceConnectionId);
    send(client.ws, { type: "pong" });
    return;
  }
  if (msg.type === "hello") return hello(client, msg, wsCursor);
  // "The operator is / is no longer in front of this client", decoupled from
  // route presence. The browser derives it from tab visibility and deliberate
  // gestures; a native app has foreground/background and nothing else.
  if (msg.type === "audio:claim" || msg.type === "audio:release") {
    if (client.audioClientId) {
      if (msg.type === "audio:claim") promoteAudioFocus(client.userId, client.audioClientId);
      else setAudioFocusActive(client.userId, client.audioClientId, false);
      client.syncAudio();
    }
    return;
  }
  if (!client.workspaceId) return; // everything else requires a workspace
  if (msg.type === "resume") return resume(client, msg.cursor, wsCursor);
  if (msg.type === "presence:set") return setPresence(client, msg);
  if (msg.type === "subscribe" && msg.peonId && msg.sessionId) return subscribe(client, msg.peonId, msg.sessionId, msg.lastEventId);
  if (msg.type === "unsubscribe" && msg.sessionId) unsubscribe(client, msg.sessionId);
}

// One client, one audio identity — a browser tab's several sockets (the selected
// workspace plus any fleet-dashboard ones) must not compete with each other.
// Untrusted input, so bound it. An absent or unusable id keeps that connection
// out of the stack entirely (see hello): a client that cannot be told to stay
// quiet must not be able to silence one that can.
function audioClientIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

async function hello(client: Client, msg: { workspaceId?: string; clientId?: string }, wsCursor: Map<string, number>): Promise<void> {
  const workspaceId = String(msg.workspaceId ?? "");
  const role = workspaceId ? await membership(workspaceId, client.userId) : null;
  if (!workspaceId || !role) {
    send(client.ws, { type: "error", error: "unknown workspace" });
    client.ws.close(4403, "unknown workspace");
    return;
  }
  if (client.closed) return;
  // Switching workspace resets everything for this socket.
  const previousWorkspaceId = client.workspaceId;
  for (const c of client.tails.values()) c.abort();
  client.tails.clear();
  client.location = null;
  if (previousWorkspaceId) removePresence(previousWorkspaceId, client.userId, client.presenceConnectionId);
  client.live = false;
  client.workspaceId = workspaceId;
  client.role = role;
  // A client that does not identify itself keeps the pre-audio-ownership
  // behaviour: it is never told to go quiet, and — just as important — it never
  // takes the sound away from a client that does. Otherwise a reconnecting
  // legacy client would look like a brand new one on every flap and would mute
  // the desktop it cannot hear itself being outranked by.
  const audioClientId = audioClientIdOf(msg.clientId);
  if (client.audioClientId && client.audioClientId !== audioClientId) {
    releaseAudioFocus(client.userId, client.audioClientId, client.presenceConnectionId);
  }
  client.audioClientId = audioClientId;
  if (audioClientId) claimAudioFocus(client.userId, audioClientId, client.presenceConnectionId);
  await refreshClientAccess(client);

  await snapshotAndReplay(client, workspaceId, wsCursor);
  // After the snapshot, so a reconnecting tab learns where it stands even when
  // the stack did not move and the bus therefore stayed quiet.
  client.syncAudio();
}

async function snapshotAndReplay(client: Client, workspaceId: string, wsCursor: Map<string, number>): Promise<void> {
  // Pause only durable fan-out while taking the materialized snapshot. Session
  // tails are independent. Anything appended in this window is replayed from the
  // snapshot barrier after live fan-out is re-enabled.
  client.live = false;
  const [snapCursor, records] = await Promise.all([latestCursor(), registry.list(workspaceId)]);
  if (client.closed || client.workspaceId !== workspaceId) return;
  send(client.ws, {
    type: "snapshot",
    presence: collectPresence(client),
    peonPresence: records
      .filter((record) => peonVisible(client, record.peonId))
      .map((record) => {
        const view = toView(record);
        return {
          peonId: view.peonId,
          name: view.name,
          online: view.online,
          controlConnected: view.controlConnected,
          controlConnectedAt: view.controlConnectedAt,
        };
      }),
    cursor: snapCursor,
  });

  // Go live BEFORE replaying the finite snapshot window. Any
  // overlap between replay and the first live frames is harmless — the client
  // merges by the payload's own timestamp (last-writer-wins), so nothing regresses
  // and nothing is missed.
  client.live = true;
  const [throughCursor, workspaceCursor] = await Promise.all([latestCursor(), latestCursor(workspaceId)]);
  wsCursor.set(workspaceId, Math.max(workspaceCursor, wsCursor.get(workspaceId) ?? 0));
  await replayWindow(client, workspaceId, snapCursor, throughCursor);
  if (!client.closed && client.workspaceId === workspaceId) send(client.ws, { type: "resumeEnd", cursor: throughCursor });
}

// Replay only — events newer than the client's cursor, no snapshot, no tail reset.
// This is the cheap counterpart to hello: the client uses it to fill a gap it
// detected from a `sync` without tearing down the socket or its live tails.
async function resume(client: Client, cursor: number | undefined, wsCursor: Map<string, number>): Promise<void> {
  if (!client.live || !client.workspaceId) return;
  const workspaceId = client.workspaceId;
  const from = Math.max(0, Number(cursor) || 0);
  const oldest = await oldestCursor();
  // The requested point predates the retained log, so replay alone cannot prove
  // completeness. Refresh materialized state without disturbing active tails.
  if (from > 0 && oldest > 0 && from < oldest - 1) {
    await snapshotAndReplay(client, workspaceId, wsCursor);
    return;
  }
  const throughCursor = await latestCursor();
  await replayWindow(client, workspaceId, from, throughCursor);
  if (!client.closed && client.workspaceId === workspaceId) send(client.ws, { type: "resumeEnd", cursor: throughCursor });
}

async function replayWindow(client: Client, workspaceId: string, from: number, through: number): Promise<void> {
  let cursor = from;
  while (!client.closed && client.workspaceId === workspaceId && cursor < through) {
    const page = await readEventsSince(workspaceId, cursor, REPLAY_PAGE_SIZE, through);
    if (page.length === 0) break;
    for (const e of page) {
      if (client.closed || client.workspaceId !== workspaceId) return;
      if (e.kind === "transcript") continue;
      if (eventVisible(client, e)) send(client.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
    }
    cursor = page[page.length - 1]!.cursor;
    if (page.length < REPLAY_PAGE_SIZE) break;
  }
}

async function setPresence(
  client: Client,
  msg: { scope?: string; peonId?: string; sessionId?: string; active?: boolean },
): Promise<void> {
  if (!client.workspaceId) return;
  client.presenceActive = msg.active !== false;
  // Returning to a machine is the strongest "play sound here" signal there is,
  // and a tab that went hidden should not keep the sound in a pocket.
  if (client.audioClientId) setAudioFocusActive(client.userId, client.audioClientId, client.presenceActive);
  let next: PresenceLocation;
  if (msg.scope === "workspace") {
    next = { scope: "workspace", peonId: null, sessionId: null, projectKey: null, projectId: null };
  } else if (msg.scope === "peon" || msg.scope === "session") {
    const peonId = String(msg.peonId ?? "");
    const record = peonId ? await registry.get(peonId) : null;
    if (!record || record.workspaceId !== client.workspaceId || !peonVisible(client, peonId)) {
      updateLocation(client, { scope: "workspace", peonId: null, sessionId: null, projectKey: null, projectId: null });
      send(client.ws, { type: "presenceRetry", reason: "unknown peon" });
      return;
    }
    if (msg.scope === "peon") {
      next = { scope: "peon", peonId, sessionId: null, projectKey: null, projectId: null };
    } else {
      const sessionId = String(msg.sessionId ?? "");
      const session = sessionId ? await getIndexedSession(peonId, sessionId) : null;
      if (!session || !sessionVisible(client, peonId, session.projectKey, session.projectId)) {
        // A just-created session can reach the route before its pushed index row.
        // Ask the browser to retry; validation remains entirely local to Overseer.
        updateLocation(client, { scope: "peon", peonId, sessionId: null, projectKey: null, projectId: null });
        send(client.ws, { type: "presenceRetry", reason: "unknown session" });
        return;
      }
      next = { scope: "session", peonId, sessionId, projectKey: session.projectKey, projectId: session.projectId };
    }
  } else {
    return;
  }
  updateLocation(client, next);
}

function updateLocation(client: Client, next: PresenceLocation): void {
  if (!client.workspaceId) return;
  client.location = next;
  heartbeatPresence({
    connectionId: client.presenceConnectionId,
    workspaceId: client.workspaceId,
    ...client.identity,
    scope: next.scope,
    peonId: next.peonId,
    sessionId: next.sessionId,
    projectKey: next.projectKey,
    projectId: next.projectId,
    active: client.presenceActive,
  });
}

async function subscribe(client: Client, peonId: string, sessionId: string, requestedLastEventId?: string): Promise<void> {
  if (client.tails.has(sessionId)) return;
  // Reserve the slot BEFORE the first await. Two subscribe messages for the same
  // session arrive back-to-back (the mount effect + the onopen re-subscribe); without
  // this reservation both pass the has() check across the await and attach TWO peon
  // streams, so every tail frame is delivered twice. Reserving synchronously closes
  // the race — the second call sees the slot and returns.
  const ctrl = new AbortController();
  client.tails.set(sessionId, ctrl);
  const record = await registry.get(peonId);
  if (client.closed || ctrl.signal.aborted || client.tails.get(sessionId) !== ctrl) return;
  if (!record || record.workspaceId !== client.workspaceId) {
    if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
    send(client.ws, { type: "tailError", peonId, sessionId, error: "unknown peon", retryable: false });
    return;
  }
  if (!peonVisible(client, peonId)) {
    if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
    send(client.ws, { type: "tailError", peonId, sessionId, error: "unknown peon", retryable: false });
    return;
  }
  const indexed = await getIndexedSession(peonId, sessionId);
  const transcriptState = await getTranscriptState(peonId, sessionId);
  const reverseAuthority = transcriptState?.epoch != null || hasReverseTranscriptConnection(peonId);
  if (client.role !== "owner") {
    let projectKey = indexed?.projectKey ?? null;
    let projectId = indexed?.projectId ?? null;
    let found = indexed !== null;
    if (!found && !reverseAuthority) {
      const detail = await callPeon(connOfRecord(record), "GET", `/sessions/${encodeURIComponent(sessionId)}`, { actor: client.actor });
      found = detail.ok;
      projectKey = detail.ok && detail.json && typeof detail.json === "object" && typeof (detail.json as { projectKey?: unknown }).projectKey === "string"
        ? (detail.json as { projectKey: string }).projectKey
        : null;
      projectId = detail.ok && detail.json && typeof detail.json === "object" && typeof (detail.json as { projectId?: unknown }).projectId === "string"
        ? (detail.json as { projectId: string }).projectId
        : null;
    }
    if (!found || (projectKey && !projectVisible(client, peonId, projectKey, projectId))) {
      if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
      send(client.ws, { type: "tailError", peonId, sessionId, error: "unknown session", retryable: false });
      return;
    }
  }

  if (reverseAuthority) {
    if (!hasReverseTranscriptConnection(peonId)) {
      if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
      send(client.ws, { type: "tailError", peonId, sessionId, error: "transcript stream is offline" });
      return;
    }
    const tail: ReverseTailState = {
      peonId,
      sessionId,
      ready: false,
      pending: [],
      pendingBytes: 0,
      seen: new Set(),
      release: null,
      delivery: Promise.resolve(),
    };
    reverseTails.set(ctrl, tail);
    ctrl.signal.addEventListener("abort", () => tail.release?.(), { once: true });
    try {
      // The cached socket ACL above is useful for rejecting obvious bad input,
      // but it must never be the gate that creates Peon-side transcript demand.
      // Re-read the current membership/session/project grants before acquire can
      // emit transcript_subscribe or transcript_snapshot_request.
      if (!(await currentTranscriptAccess(client, peonId, sessionId))) {
        closeRevokedTail(client, ctrl, tail);
        return;
      }
      if (client.closed || ctrl.signal.aborted || client.tails.get(sessionId) !== ctrl) return;
      tail.release = await acquireTranscriptProjection(peonId, sessionId);
      if (ctrl.signal.aborted || client.tails.get(sessionId) !== ctrl) {
        tail.release();
        tail.release = null;
        return;
      }
      if (!(await currentTranscriptAccess(client, peonId, sessionId))) {
        closeRevokedTail(client, ctrl, tail);
        return;
      }
      const lastEventId = typeof requestedLastEventId === "string"
        && requestedLastEventId.length > 0
        && requestedLastEventId.length <= 512
        && !/[\r\n]/.test(requestedLastEventId)
        ? requestedLastEventId
        : null;
      const replay = await readTranscriptAfter({ peonId, sessionId, lastEventId });
      for (const event of replay) {
        if (!(await currentTranscriptAccess(client, peonId, sessionId))) {
          closeRevokedTail(client, ctrl, tail);
          return;
        }
        await sendProjectedEvent(client, tail, event);
      }
      while (tail.pending.length > 0) {
        const pending = tail.pending.splice(0).sort((left, right) => left.cursor - right.cursor);
        tail.pendingBytes = 0;
        for (const live of pending) {
          if (!(await deliverProjectedTail(client, ctrl, tail, live))) return;
        }
      }
      tail.ready = true;
    } catch (error) {
      if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
      ctrl.abort();
      send(client.ws, {
        type: "tailError",
        peonId,
        sessionId,
        error: error instanceof Error ? error.message : "transcript stream unavailable",
      });
    }
    return;
  }

  let buf = "";
  let streamError: string | null = null;
  // Durable transcript Peons use the standard SSE resume header to begin strictly
  // after the bounded HTTP snapshot. Legacy Peons retain their historical stream
  // behavior, and untrusted socket input cannot become a malformed HTTP header.
  const lastEventId = record.capabilities.includes("transcript-pagination-v1")
    && typeof requestedLastEventId === "string"
    && requestedLastEventId.length > 0
    && requestedLastEventId.length <= 1024
    && !/[\r\n]/.test(requestedLastEventId)
    ? requestedLastEventId
    : null;
  void streamPeonTo(
    connOfRecord(record),
    `/sessions/${encodeURIComponent(sessionId)}/stream`,
    (text) => {
      if (client.tails.get(sessionId) !== ctrl || ctrl.signal.aborted) return;
      buf += text;
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buf);
        if (!boundary) break;
        const rawFrame = buf.slice(0, boundary.index);
        buf = buf.slice(boundary.index + boundary[0].length);
        if (Buffer.byteLength(rawFrame) > MAX_SSE_FRAME_BYTES) {
          streamError = "peon sent an oversized SSE frame";
          ctrl.abort();
          break;
        }
        const frame = parseSse(rawFrame);
        if (frame) send(client.ws, { type: "tail", peonId, sessionId, event: frame.event, id: frame.id, data: frame.data });
      }
      if (Buffer.byteLength(buf) > MAX_SSE_FRAME_BYTES) {
        streamError = "peon sent an oversized SSE frame";
        ctrl.abort();
      }
    },
    ctrl.signal,
    client.actor,
    lastEventId,
  )
    .catch(() => {
      streamError ??= "peon unreachable";
    })
    .finally(() => {
      // A replaced/unsubscribed stream must never terminate its successor. Only
      // the controller that still owns this session is allowed to emit terminal
      // state and release the slot.
      if (client.tails.get(sessionId) !== ctrl) return;
      client.tails.delete(sessionId);
      if (streamError) send(client.ws, { type: "tailError", peonId, sessionId, error: streamError });
      else if (!ctrl.signal.aborted) send(client.ws, { type: "tailEnd", peonId, sessionId });
    });
}

function unsubscribe(client: Client, sessionId: string): void {
  client.tails.get(sessionId)?.abort();
  client.tails.delete(sessionId);
}

async function sendProjectedTail(client: Client, tail: ReverseTailState, live: LiveEvent): Promise<void> {
  const payload = live.payload && typeof live.payload === "object"
    ? live.payload as { event?: unknown }
    : null;
  if (!payload?.event || typeof payload.event !== "object" || Array.isArray(payload.event)) return;
  await sendProjectedEvent(client, tail, payload.event as Record<string, unknown>);
}

async function currentTranscriptAccess(client: Client, peonId: string, sessionId: string): Promise<boolean> {
  if (!client.workspaceId) return false;
  return canAccessIndexedSessionNow(client.workspaceId, client.userId, peonId, sessionId);
}

function closeRevokedTail(client: Client, controller: AbortController, tail: ReverseTailState): void {
  if (client.tails.get(tail.sessionId) !== controller) return;
  controller.abort();
  client.tails.delete(tail.sessionId);
  send(client.ws, {
    type: "tailError",
    peonId: tail.peonId,
    sessionId: tail.sessionId,
    error: "unknown session",
    retryable: false,
  });
}

async function deliverProjectedTail(
  client: Client,
  controller: AbortController,
  tail: ReverseTailState,
  live: LiveEvent,
): Promise<boolean> {
  if (client.tails.get(tail.sessionId) !== controller || controller.signal.aborted) return false;
  if (!(await currentTranscriptAccess(client, tail.peonId, tail.sessionId))) {
    closeRevokedTail(client, controller, tail);
    return false;
  }
  if (client.tails.get(tail.sessionId) !== controller || controller.signal.aborted) return false;
  if (live.payload && typeof live.payload === "object"
    && (live.payload as { deleted?: unknown }).deleted === true) {
    controller.abort();
    client.tails.delete(tail.sessionId);
    send(client.ws, { type: "tailEnd", peonId: tail.peonId, sessionId: tail.sessionId });
    return false;
  }
  await sendProjectedTail(client, tail, live);
  return true;
}

async function sendProjectedEvent(client: Client, tail: ReverseTailState, event: Record<string, unknown>): Promise<void> {
  const eventId = typeof event.eventId === "string" ? event.eventId : null;
  if (!eventId || tail.seen.has(eventId)) return;
  tail.seen.add(eventId);
  // Authorship is resolved on the way out, exactly as the paginated transcript
  // resolves it: the projection stores only the actor string the Peon sent.
  const enriched = await enrichLiveTranscriptEvent(event);
  send(client.ws, {
    type: "tail",
    peonId: tail.peonId,
    sessionId: tail.sessionId,
    event: "event",
    id: eventId,
    data: JSON.stringify(enriched),
  });
}

function broadcastPresence(clients: Set<Client>, workspaceId: string): void {
  for (const client of clients) {
    if (!client.live || client.workspaceId !== workspaceId) continue;
    send(client.ws, { type: "presence", presence: collectPresence(client) });
  }
}

function collectPresence(recipient: Client): PresenceEntry[] {
  if (!recipient.workspaceId) return [];
  const entries = new Map<string, PresenceEntry>();
  for (const entry of listHeartbeatPresence(recipient.workspaceId)) {
    if (entry.peonId && !peonVisible(recipient, entry.peonId)) continue;
    if (entry.scope === "session" && entry.peonId && !sessionVisible(recipient, entry.peonId, entry.projectKey, entry.projectId)) continue;
    const key = `${entry.userId}\0${entry.scope}\0${entry.peonId ?? ""}\0${entry.sessionId ?? ""}`;
    if (!entries.has(key)) entries.set(key, {
      userId: entry.userId,
      email: entry.email,
      githubLogin: entry.githubLogin,
      avatarUrl: entry.avatarUrl,
      scope: entry.scope,
      peonId: entry.peonId,
      sessionId: entry.sessionId,
    });
  }
  return [...entries.values()].sort((a, b) => (a.githubLogin || a.email).localeCompare(b.githubLogin || b.email));
}

// transcript row and its replayed live frame, so preserve it across the bridge.
// Minimal SSE frame parse: `event:`/`id:` plus one or more `data:` lines.
// Peon's monotonically increasing id is the stable identity across reconnects.
export function parseSse(frame: string): { event: string | null; id: string | null; data: string } | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (event === null && data.length === 0) return null; // comment/keepalive
  return { event, id, data: data.join("\n") };
}
