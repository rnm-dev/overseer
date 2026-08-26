import type { IncomingMessage, Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { consumeWebSocketTicket } from "../modules/auth/index.js";
import { membership, type Role } from "../modules/workspaces/index.js";
import { registry, toView } from "../modules/fleet/index.js";
import {
  consumeSessionParticipantWebSocketTicket,
  getIndexedSession,
  getSessionParticipantById,
  indexAcceptedSession,
  sessionSharingBus,
  type SessionParticipantAuth,
} from "../modules/sessions/index.js";
import { bus, latestCursor, oldestCursor, readEventsSince, type LiveEvent } from "../infrastructure/events/index.js";
import { callPeon, connOfRecord, streamPeonTo } from "../infrastructure/peonHttp/index.js";
import { eventVisible, peonVisible, projectVisible, refreshClientAccess, sessionVisible } from "../modules/access/index.js";
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
} from "../modules/presence/index.js";
import { canAccessIndexedSessionNow } from "../modules/access/index.js";
import { enrichLiveTranscriptEvent } from "../modules/sessions/index.js";
import { observeSessionCatalogDuration } from "../modules/sessions/index.js";
import { claimUpgrade } from "./upgradeGuard.js";

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
  deliveredResourceCursors: Map<number, { kind: "session" | "project" | "peon"; committedAt: number | null }>;
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
  participant: SessionParticipantAuth | null;
  // Publishes audio ownership to every socket of this client's operator.
  syncAudio: () => void;
}

interface PresenceUser {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  displayName?: string | null;
  participantId?: string | null;
  isGuest?: boolean;
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
  displayName?: string | null;
  participantId?: string | null;
  isGuest?: boolean;
}

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_AUTH_MESSAGES = 32;
const MAX_QUEUED_MESSAGES = 256;
const REPLAY_PAGE_SIZE = 1000;
const MAX_SSE_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_TRANSCRIPT_EVENTS = 1_000;
const MAX_PENDING_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_RESOURCE_APPLY_CLOCKS = 1_024;

function rememberDeliveredResource(client: Client, event: LiveEvent, measureApply = true): void {
  if (!(["session", "project", "peon"] as const).includes(event.kind as "session" | "project" | "peon") || event.cursor <= 0) return;
  client.deliveredResourceCursors.set(event.cursor, {
    kind: event.kind as "session" | "project" | "peon",
    committedAt: measureApply ? event.createdAt : null,
  });
  while (client.deliveredResourceCursors.size > MAX_CLIENT_RESOURCE_APPLY_CLOCKS) {
    const oldest = client.deliveredResourceCursors.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    client.deliveredResourceCursors.delete(oldest);
  }
}

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
    claimUpgrade(req);
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
      let participantAuth: SessionParticipantAuth | null = null;
      try {
        auth = ticket ? await consumeWebSocketTicket(ticket) : null;
        if (!auth && ticket) participantAuth = await consumeSessionParticipantWebSocketTicket(ticket);
      } catch {
        if (!disconnected) ws.close(1011, "authentication unavailable");
        return;
      }
      if (disconnected || ws.readyState !== WebSocket.OPEN) return;
      if (!auth && !participantAuth) return ws.close(4401, "unauthorized");
      const userId = auth?.userId ?? participantAuth?.userId ?? participantAuth?.guestId ?? participantAuth!.participantId;
      const actor = auth?.email ?? participantAuth!.actor;
      const identity: PresenceUser = auth
        ? { userId: auth.userId, email: auth.email, githubLogin: auth.githubLogin, avatarUrl: auth.avatarUrl }
        : {
          userId,
          email: participantAuth!.email ?? participantAuth!.actor,
          githubLogin: participantAuth!.githubLogin,
          avatarUrl: participantAuth!.avatarUrl,
          displayName: participantAuth!.displayName,
          participantId: participantAuth!.participantId,
          isGuest: participantAuth!.isGuest,
        };

      client = {
        presenceConnectionId: `ws:${randomUUID()}`,
        ws,
        userId,
        actor,
        identity,
        workspaceId: null,
        role: null,
        allowedPeons: null,
        allowedProjects: null,
        live: false,
        alive: true,
        closed: false,
        queuedMessages: 0,
        deliveredResourceCursors: new Map(),
        messageQueue: Promise.resolve(),
        tails: new Map(),
        location: null,
        presenceActive: true,
        audioClientId: null,
        audioPrimary: null,
        participant: participantAuth,
        syncAudio: () => syncAudio(userId),
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
      // Transcript rows never enter the shared event log. Each subscribed tail
      // is bridged directly from Peon's committed Fleet HTTP stream below.
      if (e.kind === "transcript") continue;
      if ((c.live || presenceDuringSnapshot) && c.workspaceId === e.workspaceId && eventVisible(c, e)) {
        rememberDeliveredResource(c, e);
        send(c.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
      }
    }
  };
  bus.on("event", onBusEvent);
  const onPresenceChange = (workspaceId: string) => broadcastPresence(clients, workspaceId);
  presenceBus.on("changed", onPresenceChange);
  const onParticipantRevoked = (event: { participantId: string }) => {
    for (const client of clients) {
      if (client.participant?.participantId === event.participantId) closeRevokedParticipant(client);
    }
  };
  sessionSharingBus.onParticipantRevoked(onParticipantRevoked);
  const onAudioFocusChange = (userId: string) => syncAudio(userId);
  audioFocusBus.on("changed", onAudioFocusChange);
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
        if (client.participant && !(await getSessionParticipantById(client.participant.participantId))) {
          closeRevokedParticipant(client);
          return;
        }
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
    sessionSharingBus.offParticipantRevoked(onParticipantRevoked);
    audioFocusBus.off("changed", onAudioFocusChange);
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
  let msg: { type?: string; kind?: string; workspaceId?: string; cursor?: number; scope?: string; peonId?: string; sessionId?: string; lastEventId?: string; clientId?: string };
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
  if (msg.type === "session:applied" || msg.type === "resource:applied") {
    const cursor = Number(msg.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= 0 || cursor > (wsCursor.get(client.workspaceId) ?? 0)) return;
    const delivered = client.deliveredResourceCursors.get(cursor);
    if (!delivered) return;
    const claimedKind = msg.type === "session:applied" ? "session" : String(msg.kind ?? "");
    if (claimedKind !== delivered.kind) return;
    client.deliveredResourceCursors.delete(cursor);
    if (delivered.committedAt !== null) {
      const stage = delivered.kind === "session" ? "client_apply" : `${delivered.kind}_apply`;
      observeSessionCatalogDuration(stage, "success", Date.now() - delivered.committedAt);
    }
    return;
  }
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
  const role = client.participant
    ? workspaceId === client.participant.workspaceId ? "member" as const : null
    : workspaceId ? await membership(workspaceId, client.userId) : null;
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
      if (eventVisible(client, e)) {
        rememberDeliveredResource(client, e, false);
        send(client.ws, { type: e.kind, cursor: e.cursor, payload: e.payload });
      }
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
  if (client.participant && msg.scope !== "session") {
    send(client.ws, { type: "presenceRetry", reason: "session presence required" });
    return;
  }
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
      const participantSession = client.participant
        && client.participant.peonId === peonId
        && client.participant.sessionId === sessionId;
      if ((!session && !participantSession) || (!client.participant && !sessionVisible(client, peonId, session!.projectKey, session!.projectId))) {
        // A just-created session can reach the route before its pushed index row.
        // Ask the browser to retry; validation remains entirely local to Overseer.
        updateLocation(client, { scope: "peon", peonId, sessionId: null, projectKey: null, projectId: null });
        send(client.ws, { type: "presenceRetry", reason: "unknown session" });
        return;
      }
      next = { scope: "session", peonId, sessionId, projectKey: session?.projectKey ?? null, projectId: session?.projectId ?? null };
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
  if (client.participant) {
    const current = await getSessionParticipantById(client.participant.participantId);
    if (!current || current.peonId !== peonId || current.sessionId !== sessionId) {
      if (client.tails.get(sessionId) === ctrl) client.tails.delete(sessionId);
      send(client.ws, { type: "tailError", peonId, sessionId, error: "participant access was revoked", retryable: false });
      return;
    }
  } else if (client.role !== "owner") {
    let projectKey = indexed?.projectKey ?? null;
    let projectId = indexed?.projectId ?? null;
    let found = indexed !== null;
    if (!found) {
      const detail = await callPeon(connOfRecord(record), "GET", `/sessions/${encodeURIComponent(sessionId)}`, { actor: client.actor });
      found = detail.ok;
      if (detail.ok) await indexAcceptedSession(detail, record.workspaceId, peonId);
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

  let buf = "";
  let streamError: string | null = null;
  let pendingFrames = 0;
  let pendingBytes = 0;
  let delivery = Promise.resolve();
  // The stable eventId from the newest HTTP page is the only resume boundary.
  // Untrusted socket input cannot become a malformed HTTP header.
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
        if (!frame) continue;
        const bytes = Buffer.byteLength(rawFrame);
        pendingFrames += 1;
        pendingBytes += bytes;
        if (pendingFrames > MAX_PENDING_TRANSCRIPT_EVENTS || pendingBytes > MAX_PENDING_TRANSCRIPT_BYTES) {
          streamError = "transcript live-tail buffer exceeded";
          ctrl.abort();
          break;
        }
        delivery = delivery
          .then(() => deliverDirectTailFrame(client, ctrl, peonId, sessionId, frame))
          .catch(() => {
            streamError ??= "transcript live-tail delivery failed";
            ctrl.abort();
          })
          .finally(() => {
            pendingFrames -= 1;
            pendingBytes -= bytes;
          });
      }
      if (Buffer.byteLength(buf) > MAX_SSE_FRAME_BYTES) {
        streamError = "peon sent an oversized SSE frame";
        ctrl.abort();
      }
    },
    ctrl.signal,
    client.actor,
    lastEventId,
    () => {
      if (client.tails.get(sessionId) !== ctrl || ctrl.signal.aborted) return;
      send(client.ws, { type: "tailReady", peonId, sessionId });
    },
  )
    .catch(() => {
      streamError ??= "peon unreachable";
    })
    .finally(async () => {
      await delivery;
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

async function currentTranscriptAccess(client: Client, peonId: string, sessionId: string): Promise<boolean> {
  if (!client.workspaceId) return false;
  if (client.participant) {
    const current = await getSessionParticipantById(client.participant.participantId);
    return Boolean(current && current.peonId === peonId && current.sessionId === sessionId);
  }
  const currentRole = await membership(client.workspaceId, client.userId);
  if (currentRole === "owner") return true;
  if (!currentRole) return false;
  return canAccessIndexedSessionNow(client.workspaceId, client.userId, peonId, sessionId);
}

function closeRevokedTail(client: Client, controller: AbortController, peonId: string, sessionId: string): void {
  if (client.tails.get(sessionId) !== controller) return;
  controller.abort();
  client.tails.delete(sessionId);
  send(client.ws, {
    type: "tailError",
    peonId,
    sessionId,
    error: "unknown session",
    retryable: false,
  });
}

function closeRevokedParticipant(client: Client): void {
  for (const controller of client.tails.values()) controller.abort();
  client.tails.clear();
  send(client.ws, { type: "participantRevoked", error: "participant access was revoked" });
  client.ws.close(4403, "participant revoked");
}

async function deliverDirectTailFrame(
  client: Client,
  controller: AbortController,
  peonId: string,
  sessionId: string,
  frame: { event: string | null; id: string | null; data: string },
): Promise<void> {
  if (client.tails.get(sessionId) !== controller || controller.signal.aborted) return;
  if (!(await currentTranscriptAccess(client, peonId, sessionId))) {
    closeRevokedTail(client, controller, peonId, sessionId);
    return;
  }
  let data = frame.data;
  if (frame.event === "event" && frame.id) {
    try {
      const decoded = JSON.parse(frame.data) as unknown;
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        data = JSON.stringify(await enrichLiveTranscriptEvent({
          ...(decoded as Record<string, unknown>),
          eventId: frame.id,
        }));
      }
    } catch {
      // The clients reconcile malformed frames through the HTTP transcript.
    }
    // Enrichment is asynchronous. Re-read ACL so a revocation during that
    // lookup cannot leak one final transcript row.
    if (!(await currentTranscriptAccess(client, peonId, sessionId))) {
      closeRevokedTail(client, controller, peonId, sessionId);
      return;
    }
  }
  send(client.ws, {
    type: "tail",
    peonId,
    sessionId,
    event: frame.event,
    id: frame.id,
    data,
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
    if (recipient.participant) {
      if (entry.scope !== "session" || entry.peonId !== recipient.participant.peonId || entry.sessionId !== recipient.participant.sessionId) continue;
    }
    if (entry.peonId && !peonVisible(recipient, entry.peonId)) continue;
    if (!recipient.participant && entry.scope === "session" && entry.peonId && !sessionVisible(recipient, entry.peonId, entry.projectKey, entry.projectId)) continue;
    const key = `${entry.userId}\0${entry.scope}\0${entry.peonId ?? ""}\0${entry.sessionId ?? ""}`;
    if (!entries.has(key)) entries.set(key, {
      userId: entry.userId,
      email: entry.email,
      githubLogin: entry.githubLogin,
      avatarUrl: entry.avatarUrl,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      ...(entry.participantId !== undefined ? { participantId: entry.participantId } : {}),
      ...(entry.isGuest !== undefined ? { isGuest: entry.isGuest } : {}),
      scope: entry.scope,
      peonId: entry.peonId,
      sessionId: entry.sessionId,
    });
  }
  return [...entries.values()].sort((a, b) => (a.githubLogin || a.displayName || a.email).localeCompare(b.githubLogin || b.displayName || b.email));
}

// Minimal SSE frame parse: `event:`/`id:` plus one or more `data:` lines.
// Peon's persisted event id is the stable identity across reconnects.
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
