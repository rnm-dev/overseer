import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { replaceMemberAccess } from "../modules/access/index.js";
import { bindPeon, mintCredential } from "../modules/fleet/index.js";
import { initDb, query } from "../infrastructure/db/index.js";
import { attachLiveSocket } from "./liveSocket.js";
import {
  issueDevice,
  issueWebSocketTicket,
  verifyDeviceToken,
} from "../modules/auth/index.js";
import { attachPeonSocket } from "./peonSocket.js";
import { TRANSCRIPT_CHANNEL_HELLO } from "./peonTranscriptSync.js";
import { registry } from "../modules/fleet/index.js";
import { createServer } from "../app/server.js";
import { upsertSession } from "../modules/sessions/index.js";
import { createWorkspace } from "../modules/workspaces/index.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function open(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

function collector(ws: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  ws.on("message", (raw) => {
    frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    for (const listener of listeners) listener();
  });
  return {
    frames,
    waitFor(predicate: (frame: Record<string, unknown>) => boolean, timeoutMs = 60_000) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const inspect = () => {
          const found = frames.find(predicate);
          if (!found) return;
          clearTimeout(timer);
          listeners.delete(inspect);
          resolve(found);
        };
        const timer = setTimeout(() => {
          listeners.delete(inspect);
          reject(new Error(`timed out; received ${JSON.stringify(frames)}`));
        }, timeoutMs);
        listeners.add(inspect);
        inspect();
      });
    },
  };
}

function sseCollector(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  const next = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out reading SSE; received ${body}`)),
        60_000,
      );
      void reader.read().then(
        (chunk) => {
          clearTimeout(timer);
          resolve(chunk);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  return {
    async waitFor(fragment: string): Promise<string> {
      while (!body.includes(fragment)) {
        const chunk = await next();
        if (chunk.done) throw new Error(`SSE ended before ${fragment}; received ${body}`);
        body += decoder.decode(chunk.value, { stream: true });
      }
      return body;
    },
    async waitForEnd(): Promise<string> {
      for (;;) {
        const chunk = await next();
        if (chunk.done) return body + decoder.decode();
        body += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

async function authFor(userId: string, email: string): Promise<{ ticket: string; token: string }> {
  const device = await issueDevice(userId, "test", { ip: null, userAgent: null });
  const auth = await verifyDeviceToken(device.token);
  assert.ok(auth);
  return { ticket: (await issueWebSocketTicket({ ...auth, email })).ticket, token: device.token };
}

function published(seq: number): Record<string, unknown> & { event: Record<string, unknown> } {
  return {
    sessionId: "session-1",
    epoch: "transcript-epoch",
    revision: seq,
    seq,
    eventId: `event-${seq}`,
    createdAt: 1_000 + seq,
    eventType: seq === 2 ? "result" : "assistant",
    author: null,
    usage: seq === 2 ? { output_tokens: 9 } : null,
    event: { type: seq === 2 ? "result" : "assistant", text: `event ${seq}` },
    artifactRefs: [],
  };
}

test("reverse transcript snapshot/live/replay reaches authorized browsers once and ACL denial sends no Peon request", async (t) => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO users (id,email,created_at) VALUES
      ('owner','owner@example.test',1),('member','member@example.test',1)`,
  );
  const workspace = await createWorkspace("Transcript", "owner");
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ($1,'member','member',1)`,
    [workspace.id],
  );
  const { credential, token } = await mintCredential(workspace.id, "Peon", "owner");
  assert.equal(await bindPeon(credential.id, "peon-1"), true);
  let legacyRequests = 0;
  const legacyServer = http.createServer((_request, response) => {
    legacyRequests += 1;
    response.statusCode = 500;
    response.end("reverse transcript route must not probe legacy HTTP");
  });
  const legacyPort = await listen(legacyServer);
  t.after(async () => {
    if (legacyServer.listening) {
      await new Promise<void>((resolve, reject) =>
        legacyServer.close((error) => error ? reject(error) : resolve()));
    }
  });
  await registry.register({
    peonId: "peon-1",
    credentialId: credential.id,
    workspaceId: workspace.id,
    name: "Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: legacyPort,
    publicUrl: null,
    protocol: 1,
    capabilities: ["transcript-pagination-v1"],
    token,
    load: null,
  });
  await upsertSession(workspace.id, "peon-1", {
    id: "session-1",
    projectKey: "private",
    projectId: "project-private",
    status: "running",
    lastActivityAt: 1,
  });
  await upsertSession(workspace.id, "peon-1", {
    id: "session-2",
    projectKey: "private",
    projectId: "project-private",
    status: "running",
    lastActivityAt: 1,
  });
  await replaceMemberAccess(workspace.id, "member", {
    peonIds: ["peon-1"],
    projects: [],
  }, "owner");

  const server = http.createServer(createServer());
  const liveWss = attachLiveSocket(server);
  const peonWss = attachPeonSocket(server);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    await Promise.all(sockets.map(closeSocket));
    await new Promise<void>((resolve) => peonWss.close(() => resolve()));
    await new Promise<void>((resolve) => liveWss.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });
  const port = await listen(server);
  const peon = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  sockets.push(peon);
  const peonFrames = collector(peon);
  peon.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: "peon-1",
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "transcript-sync-v1"],
    channels: {
      "session-catalog-v1": { epoch: "catalog", revision: 0, earliestSeq: 0, latestSeq: 0 },
      "transcript-sync-v1": {
        snapshotPageEvents: 100,
        snapshotPageBytes: 786_432,
        snapshotEvents: 20_000,
        snapshotBytes: 16_777_216,
        activeSnapshots: 4,
        subscriptions: 64,
        subscriptionTtlMs: 300_000,
        eventBytes: 196_608,
      },
    },
    delivery: {
      epoch: "delivery",
      earliestCursor: null,
      latestCursor: null,
      acknowledgedCursor: null,
      pendingMessages: 0,
      pendingBytes: 0,
      maxMessages: 5_000,
      maxBytes: 33_554_432,
      backpressured: false,
      negotiated: false,
      recoveredFromCorruption: false,
      lastError: null,
    },
  }));
  const helloAck = await peonFrames.waitFor((frame) => frame.type === "hello_ack");
  assert.deepEqual(helloAck.capabilities, ["session-catalog-v1", "durable-delivery-v1", "transcript-sync-v1"]);
  const catalog = await peonFrames.waitFor((frame) => frame.type === "session_catalog_snapshot_request");
  peon.send(JSON.stringify({
    type: "session_catalog_snapshot_page",
    requestId: catalog.requestId,
    epoch: "catalog",
    revision: 0,
    barrierSeq: 0,
    sessions: [
      {
        id: "session-1",
        projectKey: "private",
        projectId: "project-private",
        status: "running",
        lastActivityAt: 1,
      },
      {
        id: "session-2",
        projectKey: "private",
        projectId: "project-private",
        status: "running",
        lastActivityAt: 1,
      },
    ],
    nextCursor: null,
    hasMore: false,
  }));
  await peonFrames.waitFor((frame) => frame.type === "session_catalog_ack");

  const ownerAuth = await authFor("owner", "owner@example.test");
  const owner = await open(`ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(ownerAuth.ticket)}`);
  sockets.push(owner);
  const ownerFrames = collector(owner);
  owner.send(JSON.stringify({ type: "hello", workspaceId: workspace.id }));
  await ownerFrames.waitFor((frame) => frame.type === "snapshot");
  owner.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "session-1" }));
  const snapshot = await peonFrames.waitFor((frame) => frame.type === "transcript_snapshot_request");
  assert.equal(snapshot.subscribe, true);
  const literalNulEscape = String.raw`\u0000`;
  const poisonedSnapshot = published(1);
  poisonedSnapshot.event = {
    ...poisonedSnapshot.event,
    text: "snapshot\0text",
    metadata: { ["snapshot\0key"]: ["nested\0value", literalNulEscape] },
  };
  peon.send(JSON.stringify({
    type: "transcript_snapshot_page",
    requestId: snapshot.requestId,
    sessionId: "session-1",
    epoch: "transcript-epoch",
    revision: 1,
    barrierSeq: 1,
    events: [poisonedSnapshot],
    nextCursor: null,
    hasMore: false,
  }));
  const first = await ownerFrames.waitFor((frame) =>
    frame.type === "tail" && frame.sessionId === "session-1" && frame.id === "event-1");
  const firstEvent = JSON.parse(String(first.data)) as Record<string, unknown>;
  assert.equal((firstEvent.reverseTranscript as { seq?: number }).seq, 1);
  assert.equal(firstEvent.text, "snapshot\uFFFDtext");
  assert.deepEqual(firstEvent.metadata, {
    ["snapshot\uFFFDkey"]: ["nested\uFFFDvalue", literalNulEscape],
  });
  owner.send(JSON.stringify({ type: "unsubscribe", sessionId: "session-1" }));
  await peonFrames.waitFor((frame) =>
    frame.type === "transcript_unsubscribe" && frame.sessionId === "session-1");
  owner.send(JSON.stringify({
    type: "subscribe",
    peonId: "peon-1",
    sessionId: "session-1",
    lastEventId: "event-1",
  }));
  const resumed = await peonFrames.waitFor((frame) =>
    frame.type === "transcript_subscribe" && frame.sessionId === "session-1");
  peon.send(JSON.stringify({
    type: "transcript_subscribed",
    requestId: resumed.requestId,
    sessionId: "session-1",
    epoch: "transcript-epoch",
    afterSeq: 1,
    expiresAt: Date.now() + 300_000,
  }));

  const poisonedLive = published(2);
  poisonedLive.event = {
    ...poisonedLive.event,
    text: "live\0text",
    metadata: { deep: { value: "\0", literalNulEscape } },
  };
  const live = {
    type: "durable_message",
    capability: "transcript-sync-v1",
    epoch: "delivery",
    cursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000002",
    priority: "critical",
    payload: { type: "transcript_live_event", ...poisonedLive },
  };
  peon.send(JSON.stringify(live));
  await peonFrames.waitFor((frame) => frame.type === "durable_ack" && frame.cursor === "cursor-2");
  const second = await ownerFrames.waitFor((frame) => frame.type === "tail" && frame.id === "event-2");
  const secondEvent = JSON.parse(String(second.data)) as Record<string, unknown>;
  assert.equal(secondEvent.text, "live\uFFFDtext");
  assert.deepEqual(secondEvent.metadata, {
    deep: { value: "\uFFFD", literalNulEscape },
  });
  peon.send(JSON.stringify(live));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ownerFrames.frames.filter((frame) => frame.type === "tail" && frame.id === "event-2").length, 1);

  peon.send(JSON.stringify({
    ...live,
    cursor: "cursor-3",
    messageId: "00000000-0000-4000-8000-000000000003",
    payload: { type: "transcript_live_event", ...published(3) },
  }));
  await peonFrames.waitFor((frame) => frame.type === "durable_ack" && frame.cursor === "cursor-3");
  await ownerFrames.waitFor((frame) => frame.type === "tail" && frame.id === "event-3");
  const [storedTranscript, transcriptState, deliveryState] = await Promise.all([
    query<{ seq: number; payload: Record<string, unknown> }>(
      `SELECT seq,payload FROM transcript_events
       WHERE peon_id='peon-1' AND session_id='session-1' ORDER BY seq`,
    ),
    query<{ acknowledged_seq: number }>(
      `SELECT acknowledged_seq FROM peon_transcript_sync
       WHERE peon_id='peon-1' AND session_id='session-1'`,
    ),
    query<{ acknowledged_cursor: string }>(
      `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='peon-1'`,
    ),
  ]);
  assert.equal(JSON.stringify(storedTranscript.rows).includes("\0"), false);
  assert.equal(storedTranscript.rows[0]?.payload.text, "snapshot\uFFFDtext");
  assert.equal(storedTranscript.rows[1]?.payload.text, "live\uFFFDtext");
  assert.equal(transcriptState.rows[0]?.acknowledged_seq, 3);
  assert.equal(deliveryState.rows[0]?.acknowledged_cursor, "cursor-3");
  assert.equal(peon.readyState, WebSocket.OPEN, "a sanitized transcript event must not close the control socket");

  const requestsBeforeDenied = peonFrames.frames.filter((frame) => frame.type === "transcript_snapshot_request").length;
  const memberAuth = await authFor("member", "member@example.test");
  const member = await open(`ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(memberAuth.ticket)}`);
  sockets.push(member);
  const memberFrames = collector(member);
  member.send(JSON.stringify({ type: "hello", workspaceId: workspace.id }));
  await memberFrames.waitFor((frame) => frame.type === "snapshot");
  member.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "session-1" }));
  const denied = await memberFrames.waitFor((frame) => frame.type === "tailError" && frame.sessionId === "session-1");
  assert.equal(denied.retryable, false);
  assert.equal(peonFrames.frames.filter((frame) => frame.type === "transcript_snapshot_request").length, requestsBeforeDenied);
  const missingHistory = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/peons/peon-1/sessions/missing/transcript`,
    { headers: { Authorization: `Bearer ${memberAuth.token}` } },
  );
  assert.equal(missingHistory.status, 404);
  assert.deepEqual(await missingHistory.json(), { error: "unknown session", code: "UNKNOWN_SESSION" });
  assert.equal(peonFrames.frames.filter((frame) => frame.type === "transcript_snapshot_request").length, requestsBeforeDenied);
  const deniedMemberClosed = once(member, "close");
  member.close();
  await deniedMemberClosed;

  await replaceMemberAccess(workspace.id, "member", {
    peonIds: ["peon-1"],
    projects: [{ peonId: "peon-1", projectKey: "private", projectId: "project-private" }],
  }, "owner");
  const allowedMemberAuth = await authFor("member", "member@example.test");
  const allowedMember = await open(
    `ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(allowedMemberAuth.ticket)}`,
  );
  sockets.push(allowedMember);
  const allowedMemberFrames = collector(allowedMember);
  allowedMember.send(JSON.stringify({ type: "hello", workspaceId: workspace.id }));
  await allowedMemberFrames.waitFor((frame) => frame.type === "snapshot");
  allowedMember.send(JSON.stringify({
    type: "subscribe",
    peonId: "peon-1",
    sessionId: "session-1",
  }));
  await allowedMemberFrames.waitFor((frame) =>
    frame.type === "tail" && frame.id === "event-2");
  const streamResponse = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/peons/peon-1/sessions/session-1/stream`,
    { headers: { Authorization: `Bearer ${memberAuth.token}` } },
  );
  assert.equal(streamResponse.status, 200);
  const stream = sseCollector(streamResponse);
  await stream.waitFor("id: event-2");
  await replaceMemberAccess(workspace.id, "member", {
    peonIds: ["peon-1"],
    projects: [],
  }, "owner");
  const demandFramesBeforeRevokedSubscribe = peonFrames.frames.filter((frame) =>
    frame.type === "transcript_snapshot_request" || frame.type === "transcript_subscribe").length;
  allowedMember.send(JSON.stringify({
    type: "subscribe",
    peonId: "peon-1",
    sessionId: "session-2",
  }));
  const revokedBeforeDemand = await allowedMemberFrames.waitFor((frame) =>
    frame.type === "tailError" && frame.sessionId === "session-2");
  assert.equal(revokedBeforeDemand.retryable, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    peonFrames.frames.filter((frame) =>
      frame.type === "transcript_snapshot_request" || frame.type === "transcript_subscribe").length,
    demandFramesBeforeRevokedSubscribe,
    "a cached ACL must not emit Peon demand after its authoritative grant is revoked",
  );
  const revokedHistory = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/peons/peon-1/sessions/session-2/transcript`,
    { headers: { Authorization: `Bearer ${allowedMemberAuth.token}` } },
  );
  assert.equal(revokedHistory.status, 404);
  const revokedStream = await fetch(
    `http://127.0.0.1:${port}/api/workspaces/${workspace.id}/peons/peon-1/sessions/session-2/stream`,
    { headers: { Authorization: `Bearer ${allowedMemberAuth.token}` } },
  );
  assert.equal(revokedStream.status, 404);
  assert.equal(
    peonFrames.frames.filter((frame) =>
      frame.type === "transcript_snapshot_request" || frame.type === "transcript_subscribe").length,
    demandFramesBeforeRevokedSubscribe,
    "revoked REST and SSE opens must not emit Peon demand",
  );
  peon.send(JSON.stringify({
    ...live,
    cursor: "cursor-4",
    messageId: "00000000-0000-4000-8000-000000000004",
    payload: { type: "transcript_live_event", ...published(4) },
  }));
  await peonFrames.waitFor((frame) => frame.type === "durable_ack" && frame.cursor === "cursor-4");
  const revoked = await allowedMemberFrames.waitFor((frame) =>
    frame.type === "tailError" && frame.sessionId === "session-1");
  assert.equal(revoked.retryable, false);
  assert.equal(allowedMemberFrames.frames.some((frame) =>
    frame.type === "tail" && frame.id === "event-4"), false);
  assert.doesNotMatch(await stream.waitForEnd(), /id: event-4/);
  assert.equal(legacyRequests, 0, "a negotiated reverse transcript route must never probe legacy HTTP");
});

test("a mismatched durable event covered by a racing snapshot is never ACKed", async (t) => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('owner','owner@example.test',1)`);
  const workspace = await createWorkspace("Transcript mismatch", "owner");
  const { credential, token } = await mintCredential(workspace.id, "Peon", "owner");
  assert.equal(await bindPeon(credential.id, "peon-1"), true);
  await registry.register({
    peonId: "peon-1",
    credentialId: credential.id,
    workspaceId: workspace.id,
    name: "Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 1,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });
  await upsertSession(workspace.id, "peon-1", {
    id: "session-1",
    projectKey: "private",
    projectId: "project-private",
    status: "running",
    lastActivityAt: 1,
  });

  const server = http.createServer(createServer());
  const peonWss = attachPeonSocket(server);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    await Promise.all(sockets.map(closeSocket));
    await new Promise<void>((resolve) => peonWss.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });
  const port = await listen(server);
  const peon = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  sockets.push(peon);
  const frames = collector(peon);
  peon.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: "peon-1",
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "transcript-sync-v1"],
    channels: {
      "session-catalog-v1": { epoch: "catalog", revision: 0, earliestSeq: 0, latestSeq: 0 },
      "transcript-sync-v1": {
        snapshotPageEvents: 100,
        snapshotPageBytes: 786_432,
        snapshotEvents: 20_000,
        snapshotBytes: 16_777_216,
        activeSnapshots: 4,
        subscriptions: 64,
        subscriptionTtlMs: 300_000,
        eventBytes: 196_608,
      },
    },
    delivery: {
      epoch: "delivery",
      earliestCursor: "cursor-2",
      latestCursor: "cursor-2",
      acknowledgedCursor: null,
      pendingMessages: 1,
      pendingBytes: 512,
      maxMessages: 5_000,
      maxBytes: 33_554_432,
      backpressured: false,
      negotiated: false,
      recoveredFromCorruption: false,
      lastError: null,
    },
  }));
  await frames.waitFor((frame) => frame.type === "hello_ack");
  const catalog = await frames.waitFor((frame) => frame.type === "session_catalog_snapshot_request");
  peon.send(JSON.stringify({
    type: "session_catalog_snapshot_page",
    requestId: catalog.requestId,
    epoch: "catalog",
    revision: 0,
    barrierSeq: 0,
    sessions: [{
      id: "session-1",
      projectKey: "private",
      projectId: "project-private",
      status: "running",
      lastActivityAt: 1,
    }],
    nextCursor: null,
    hasMore: false,
  }));
  await frames.waitFor((frame) => frame.type === "session_catalog_ack");

  peon.send(JSON.stringify({
    type: "durable_message",
    capability: "transcript-sync-v1",
    epoch: "delivery",
    cursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000002",
    priority: "critical",
    payload: {
      type: "transcript_live_event",
      ...published(2),
      event: { type: "result", text: "conflicting durable payload" },
    },
  }));
  const snapshot = await frames.waitFor((frame) => frame.type === "transcript_snapshot_request");
  const closed = once(peon, "close");
  peon.send(JSON.stringify({
    type: "transcript_snapshot_page",
    requestId: snapshot.requestId,
    sessionId: "session-1",
    epoch: "transcript-epoch",
    revision: 2,
    barrierSeq: 2,
    events: [published(1), published(2)],
    nextCursor: null,
    hasMore: false,
  }));
  const [closeCode] = await closed;
  assert.equal(closeCode, 1002);
  assert.equal(frames.frames.some((frame) =>
    frame.type === "durable_ack" && frame.cursor === "cursor-2"), false);
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM peon_session_inbox WHERE cursor='cursor-2'`,
  )).rows[0]?.count, 0);
  assert.equal((await query<{ acknowledged_cursor: string | null }>(
    `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='peon-1'`,
  )).rows[0]?.acknowledged_cursor, null);

});

test("transcript capability negotiation is negative without durable catalog support and rejects non-exact limits", async (t) => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('owner','owner@example.test',1)`);
  const workspace = await createWorkspace("Transcript negotiation", "owner");
  const { credential, token } = await mintCredential(workspace.id, "Peon", "owner");
  assert.equal(await bindPeon(credential.id, "peon-negotiation"), true);
  await registry.register({
    peonId: "peon-negotiation",
    credentialId: credential.id,
    workspaceId: workspace.id,
    name: "Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 1,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });

  const server = http.createServer(createServer());
  const peonWss = attachPeonSocket(server);
  const sockets: WebSocket[] = [];
  t.after(async () => {
    await Promise.all(sockets.map(closeSocket));
    await new Promise<void>((resolve) => peonWss.close(() => resolve()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });
  const port = await listen(server);

  const noDurable = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  sockets.push(noDurable);
  const noDurableFrames = collector(noDurable);
  noDurable.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: "peon-negotiation",
    capabilities: ["session-catalog-v1", "transcript-sync-v1"],
    channels: {
      "session-catalog-v1": { epoch: "catalog", revision: 0, earliestSeq: 0, latestSeq: 0 },
      "transcript-sync-v1": TRANSCRIPT_CHANNEL_HELLO,
    },
  }));
  const negativeAck = await noDurableFrames.waitFor((frame) => frame.type === "hello_ack");
  assert.deepEqual(negativeAck.capabilities, []);
  assert.equal(
    noDurableFrames.frames.some((frame) => frame.type === "transcript_snapshot_request"),
    false,
  );
  await closeSocket(noDurable);

  const malformed = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  sockets.push(malformed);
  const malformedFrames = collector(malformed);
  const closed = once(malformed, "close");
  malformed.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: "peon-negotiation",
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "transcript-sync-v1"],
    channels: {
      "session-catalog-v1": { epoch: "catalog", revision: 0, earliestSeq: 0, latestSeq: 0 },
      "transcript-sync-v1": {
        ...TRANSCRIPT_CHANNEL_HELLO,
        subscriptions: TRANSCRIPT_CHANNEL_HELLO.subscriptions - 1,
      },
    },
    delivery: {
      epoch: "delivery",
      earliestCursor: null,
      latestCursor: null,
      acknowledgedCursor: null,
      pendingMessages: 0,
      pendingBytes: 0,
      maxMessages: 5_000,
      maxBytes: 33_554_432,
      backpressured: false,
      negotiated: false,
      recoveredFromCorruption: false,
      lastError: null,
    },
  }));
  const [code, reason] = await closed;
  assert.equal(code, 1002);
  assert.match(reason.toString(), /invalid transcript channel state/);
  assert.equal(
    malformedFrames.frames.some((frame) =>
      frame.type === "hello_ack"
      && Array.isArray(frame.capabilities)
      && frame.capabilities.includes("transcript-sync-v1")),
    false,
  );

  const oversized = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  sockets.push(oversized);
  const oversizedFrames = collector(oversized);
  oversized.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: "peon-negotiation",
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "transcript-sync-v1"],
    channels: {
      "session-catalog-v1": { epoch: "catalog", revision: 0, earliestSeq: 0, latestSeq: 0 },
      "transcript-sync-v1": TRANSCRIPT_CHANNEL_HELLO,
    },
    delivery: {
      epoch: "delivery",
      earliestCursor: null,
      latestCursor: null,
      acknowledgedCursor: null,
      pendingMessages: 0,
      pendingBytes: 0,
      maxMessages: 5_000,
      maxBytes: 33_554_432,
      backpressured: false,
      negotiated: false,
      recoveredFromCorruption: false,
      lastError: null,
    },
  }));
  await oversizedFrames.waitFor((frame) => frame.type === "hello_ack");
  const oversizedClosed = once(oversized, "close");
  oversized.send(JSON.stringify({
    type: "durable_message",
    capability: "transcript-sync-v1",
    epoch: "delivery",
    cursor: "oversized-cursor",
    messageId: "00000000-0000-4000-8000-000000000099",
    priority: "critical",
    payload: {
      type: "transcript_live_event",
      ...published(1),
      event: { type: "assistant", text: "x".repeat(TRANSCRIPT_CHANNEL_HELLO.eventBytes) },
    },
  }));
  const [oversizedCode, oversizedReason] = await oversizedClosed;
  assert.equal(oversizedCode, 1002);
  assert.match(oversizedReason.toString(), /exceeds negotiated eventBytes/);
  assert.equal(
    oversizedFrames.frames.some((frame) =>
      frame.type === "durable_ack" && frame.cursor === "oversized-cursor"),
    false,
  );
});
