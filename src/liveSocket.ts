import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyDeviceToken } from "./auth.js";
import { membership } from "./workspaces.js";
import { registry, toView } from "./registry.js";
import { listSessions } from "./sessionIndex.js";
import { bus, latestCursor, oldestCursor, readEventsSince, type LiveEvent } from "./eventLog.js";
import { connOfRecord, streamPeonTo } from "./peonClient.js";
import { config } from "./config.js";

// The north-bound (overseer→client) transport: one authenticated WebSocket per
// app, multiplexing peon + session state + live session tails, resumable by cursor.
//   client → { type:"hello", workspaceId, cursor? }
//   server → { type:"snapshot", peons, sessions, cursor }  then replays events>cursor, then live
//   server → { type:"peon"|"session", cursor, payload }    (live deltas; cursor:0 = transient)
//   client → { type:"subscribe"|"unsubscribe", peonId, sessionId }
//   server → { type:"tail", sessionId, event, data }       (bridged from the peon SSE)
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
  ws: WebSocket;
  userId: string;
  actor: string;
  workspaceId: string | null;
  live: boolean;
  alive: boolean;
  closed: boolean;
  queuedMessages: number;
  messageQueue: Promise<void>;
  tails: Map<string, AbortController>;
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
  const wss = new WebSocketServer({ server, path: "/api/ws", maxPayload: 64 * 1024 });
  const clients = new Set<Client>();
  // Latest appended (cursor>0) event cursor per workspace, kept in memory from the
  // bus. It's the yardstick the periodic sync hands each client so it can tell
  // whether it's caught up. Absent (process just booted, no events yet) ⇒ 0, which
  // never triggers a spurious resume (0 is never ahead of a client's cursor).
  const wsCursor = new Map<string, number>();

  wss.on("connection", (ws, req) => {
    const token = new URL(req.url ?? "", "http://x").searchParams.get("token");
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
      client.closed = true;
      for (const c of client.tails.values()) c.abort();
      client.tails.clear();
      clients.delete(client);
    });
    ws.on("error", () => {});

    void (async () => {
      let auth: Awaited<ReturnType<typeof verifyDeviceToken>> = null;
      try {
        auth = token ? await verifyDeviceToken(token) : null;
      } catch {
        if (!disconnected) ws.close(1011, "authentication unavailable");
        return;
      }
      if (disconnected || ws.readyState !== WebSocket.OPEN) return;
      if (!auth) return ws.close(4401, "unauthorized");

      client = {
        ws,
        userId: auth.userId,
        actor: auth.email,
        workspaceId: null,
        live: false,
        alive: true,
        closed: false,
        queuedMessages: 0,
        messageQueue: Promise.resolve(),
        tails: new Map(),
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
      if (c.live && c.workspaceId === e.workspaceId) send(c.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
    }
  };
  bus.on("event", onBusEvent);

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
      for (const client of clients) {
        if (client.live && client.workspaceId) send(client.ws, { type: "sync", cursor: wsCursor.get(client.workspaceId) ?? 0 });
      }
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
  let msg: { type?: string; workspaceId?: string; cursor?: number; peonId?: string; sessionId?: string };
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
    send(client.ws, { type: "pong" });
    return;
  }
  if (msg.type === "hello") return hello(client, msg, wsCursor);
  if (!client.workspaceId) return; // everything else requires a workspace
  if (msg.type === "resume") return resume(client, msg.cursor, wsCursor);
  if (msg.type === "subscribe" && msg.peonId && msg.sessionId) return subscribe(client, msg.peonId, msg.sessionId);
  if (msg.type === "unsubscribe" && msg.sessionId) unsubscribe(client, msg.sessionId);
}

async function hello(client: Client, msg: { workspaceId?: string }, wsCursor: Map<string, number>): Promise<void> {
  const workspaceId = String(msg.workspaceId ?? "");
  if (!workspaceId || !(await membership(workspaceId, client.userId))) {
    send(client.ws, { type: "error", error: "unknown workspace" });
    client.ws.close(4403, "unknown workspace");
    return;
  }
  if (client.closed) return;
  // Switching workspace resets everything for this socket.
  for (const c of client.tails.values()) c.abort();
  client.tails.clear();
  client.live = false;
  client.workspaceId = workspaceId;

  await snapshotAndReplay(client, workspaceId, wsCursor);
}

async function snapshotAndReplay(client: Client, workspaceId: string, wsCursor: Map<string, number>): Promise<void> {
  // Pause only durable fan-out while taking the materialized snapshot. Session
  // tails are independent. Anything appended in this window is replayed from the
  // snapshot barrier after live fan-out is re-enabled.
  client.live = false;
  const snapCursor = await latestCursor();
  const [peons, { sessions }] = await Promise.all([registry.list(workspaceId), listSessions({ workspaceId, limit: 500, offset: 0 })]);
  if (client.closed || client.workspaceId !== workspaceId) return;
  send(client.ws, { type: "snapshot", peons: peons.map(toView), sessions, cursor: snapCursor, offlineAfterMs: config.offlineAfterMs });

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
      send(client.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
    }
    cursor = page[page.length - 1]!.cursor;
    if (page.length < REPLAY_PAGE_SIZE) break;
  }
}

async function subscribe(client: Client, peonId: string, sessionId: string): Promise<void> {
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

  let buf = "";
  let streamError: string | null = null;
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
        if (frame) send(client.ws, { type: "tail", peonId, sessionId, event: frame.event, data: frame.data });
      }
      if (Buffer.byteLength(buf) > MAX_SSE_FRAME_BYTES) {
        streamError = "peon sent an oversized SSE frame";
        ctrl.abort();
      }
    },
    ctrl.signal,
    client.actor,
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

// Minimal SSE frame parse: `event:` line + one or more `data:` lines.
export function parseSse(frame: string): { event: string | null; data: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (event === null && data.length === 0) return null; // comment/keepalive
  return { event, data: data.join("\n") };
}
