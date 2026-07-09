import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyDeviceToken } from "./auth.js";
import { membership } from "./workspaces.js";
import { registry, toView } from "./registry.js";
import { listSessions } from "./sessionIndex.js";
import { bus, latestCursor, readEventsSince, type LiveEvent } from "./eventLog.js";
import { connOfRecord, streamPeonTo } from "./peonClient.js";

// The north-bound (overseer→client) transport: one authenticated WebSocket per
// app, multiplexing peon + session state + live session tails, resumable by cursor.
//   client → { type:"hello", workspaceId, cursor? }
//   server → { type:"snapshot", peons, sessions, cursor }  then replays events>cursor, then live
//   server → { type:"peon"|"session", cursor, payload }    (live deltas; cursor:0 = transient)
//   client → { type:"subscribe"|"unsubscribe", peonId, sessionId }
//   server → { type:"tail", sessionId, event, data }       (bridged from the peon SSE)
// author: Viktor

interface Client {
  ws: WebSocket;
  userId: string;
  workspaceId: string | null;
  live: boolean;
  alive: boolean;
  tails: Map<string, AbortController>;
}

const send = (ws: WebSocket, msg: unknown): void => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

export function attachLiveSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/api/ws" });
  const clients = new Set<Client>();

  wss.on("connection", async (ws, req) => {
    const token = new URL(req.url ?? "", "http://x").searchParams.get("token");
    const auth = token ? await verifyDeviceToken(token) : null;
    if (!auth) return ws.close(4401, "unauthorized");

    const client: Client = { ws, userId: auth.userId, workspaceId: null, live: false, alive: true, tails: new Map() };
    clients.add(client);

    ws.on("pong", () => (client.alive = true));
    ws.on("message", (data) => void onMessage(client, data.toString()).catch(() => {}));
    ws.on("close", () => {
      for (const c of client.tails.values()) c.abort();
      clients.delete(client);
    });
    ws.on("error", () => {});
  });

  // Live fan-out — every appended/broadcast event to matching, caught-up clients.
  bus.on("event", (e: LiveEvent) => {
    for (const c of clients) {
      if (c.live && c.workspaceId === e.workspaceId) send(c.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
    }
  });

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
  wss.on("close", () => clearInterval(ping));
}

async function onMessage(client: Client, raw: string): Promise<void> {
  let msg: { type?: string; workspaceId?: string; cursor?: number; peonId?: string; sessionId?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "hello") return hello(client, msg);
  if (!client.workspaceId) return; // everything else requires a workspace
  if (msg.type === "subscribe" && msg.peonId && msg.sessionId) return subscribe(client, msg.peonId, msg.sessionId);
  if (msg.type === "unsubscribe" && msg.sessionId) unsubscribe(client, msg.sessionId);
}

async function hello(client: Client, msg: { workspaceId?: string; cursor?: number }): Promise<void> {
  const workspaceId = String(msg.workspaceId ?? "");
  if (!workspaceId || !(await membership(workspaceId, client.userId))) {
    return send(client.ws, { type: "error", error: "unknown workspace" });
  }
  // Switching workspace resets everything for this socket.
  for (const c of client.tails.values()) c.abort();
  client.tails.clear();
  client.live = false;
  client.workspaceId = workspaceId;

  const snapCursor = await latestCursor();
  const [peons, { sessions }] = await Promise.all([registry.list(workspaceId), listSessions({ workspaceId, limit: 500, offset: 0 })]);
  send(client.ws, { type: "snapshot", peons: peons.map(toView), sessions, cursor: snapCursor });

  // Go live BEFORE replaying, then replay from the resume point up to now. Any
  // overlap between replay and the first live frames is harmless — the client
  // merges by the payload's own timestamp (last-writer-wins), so nothing regresses
  // and nothing is missed.
  client.live = true;
  const resume = Number(msg.cursor) || 0;
  const from = resume > 0 ? Math.min(resume, snapCursor) : snapCursor;
  for (const e of await readEventsSince(workspaceId, from)) {
    send(client.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
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
  if (!record || record.workspaceId !== client.workspaceId) {
    if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
    return send(client.ws, { type: "tailError", sessionId, error: "unknown peon" });
  }

  let buf = "";
  streamPeonTo(
    connOfRecord(record),
    `/sessions/${encodeURIComponent(sessionId)}/stream`,
    (text) => {
      buf += text;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = parseSse(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (frame) send(client.ws, { type: "tail", sessionId, event: frame.event, data: frame.data });
      }
    },
    ctrl.signal,
  )
    .catch(() => send(client.ws, { type: "tailError", sessionId, error: "peon unreachable" }))
    .finally(() => {
      if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
      send(client.ws, { type: "tailEnd", sessionId });
    });
}

function unsubscribe(client: Client, sessionId: string): void {
  client.tails.get(sessionId)?.abort();
  client.tails.delete(sessionId);
}

// Minimal SSE frame parse: `event:` line + one or more `data:` lines.
function parseSse(frame: string): { event: string | null; data: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (event === null && data.length === 0) return null; // comment/keepalive
  return { event, data: data.join("\n") };
}
