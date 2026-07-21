import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { consumeWebSocketTicket } from "./modules/auth/index.js";
import { membership, type Role } from "./workspaces.js";
import { registry, toView } from "./registry.js";
import { getIndexedSession } from "./sessionIndex.js";
import { bus, latestCursor, oldestCursor, readEventsSince, type LiveEvent } from "./eventLog.js";
import { callPeon, connOfRecord, streamPeonTo } from "./peonClient.js";
import { eventVisible, peonVisible, projectVisible, refreshClientAccess, sessionVisible } from "./liveAccess.js";
import { heartbeatPresence, listHeartbeatPresence, presenceBus, removePresence, touchPresence } from "./presence.js";

// The north-bound (overseer→client) transport: one authenticated WebSocket per
// app, multiplexing presence + live session tails, resumable by cursor.
//   client → { type:"hello", workspaceId, cursor? }
//   server → { type:"snapshot", presence, peonPresence, cursor } then replays events>cursor, then live
//   client → { type:"subscribe"|"unsubscribe", peonId, sessionId }
//   server → { type:"tail", sessionId, event, id, data }   (bridged from the peon SSE)
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

const send = (ws: WebSocket, msg: unknown): boolean => {
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
      if ((c.live || presenceDuringSnapshot) && c.workspaceId === e.workspaceId && eventVisible(c, e)) {
        send(c.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
      }
    }
  };
  bus.on("event", onBusEvent);
  const onPresenceChange = (workspaceId: string) => broadcastPresence(clients, workspaceId);
  presenceBus.on("changed", onPresenceChange);

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
  let msg: { type?: string; workspaceId?: string; cursor?: number; scope?: string; peonId?: string; sessionId?: string; lastEventId?: string };
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
  if (!client.workspaceId) return; // everything else requires a workspace
  if (msg.type === "resume") return resume(client, msg.cursor, wsCursor);
  if (msg.type === "presence:set") return setPresence(client, msg);
  if (msg.type === "subscribe" && msg.peonId && msg.sessionId) return subscribe(client, msg.peonId, msg.sessionId, msg.lastEventId);
  if (msg.type === "unsubscribe" && msg.sessionId) unsubscribe(client, msg.sessionId);
}

async function hello(client: Client, msg: { workspaceId?: string }, wsCursor: Map<string, number>): Promise<void> {
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
  await refreshClientAccess(client);

  await snapshotAndReplay(client, workspaceId, wsCursor);
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
          transferConnected: view.transferConnected,
          controlConnectedAt: view.controlConnectedAt,
          transferConnectedAt: view.transferConnectedAt,
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
      if (eventVisible(client, e)) send(client.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
    }
    cursor = page[page.length - 1]!.cursor;
    if (page.length < REPLAY_PAGE_SIZE) break;
  }
}

async function setPresence(
  client: Client,
  msg: { scope?: string; peonId?: string; sessionId?: string },
): Promise<void> {
  if (!client.workspaceId) return;
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
  if (client.role !== "owner") {
    const detail = await callPeon(connOfRecord(record), "GET", `/sessions/${encodeURIComponent(sessionId)}`, { actor: client.actor });
    const projectKey = detail.ok && detail.json && typeof detail.json === "object" && typeof (detail.json as { projectKey?: unknown }).projectKey === "string"
      ? (detail.json as { projectKey: string }).projectKey
      : null;
    const projectId = detail.ok && detail.json && typeof detail.json === "object" && typeof (detail.json as { projectId?: unknown }).projectId === "string"
      ? (detail.json as { projectId: string }).projectId
      : null;
    if (!detail.ok || (projectKey && !projectVisible(client, peonId, projectKey, projectId))) {
      if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
      send(client.ws, { type: "tailError", peonId, sessionId, error: "unknown session", retryable: false });
      return;
    }
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
