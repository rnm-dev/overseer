import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { bindPeon, mintCredential, revokeCredentialForPeon } from "./credentials.js";
import { initDb, query } from "./db.js";
import { attachLiveSocket } from "./liveSocket.js";
import { attachPeonSocket } from "./peonSocket.js";
import { registry, toView } from "./registry.js";
import { getSessionCatalogStates, listSessions, upsertSession } from "./sessionIndex.js";
import { listIndexedProjects } from "./projectIndex.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function open(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function closed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", () => resolve()));
}

function sayHello(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        assert.deepEqual(JSON.parse(data.toString()), { type: "hello_ack", protocol: 1, capabilities: [] });
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    ws.once("message", onMessage);
    ws.send(JSON.stringify({ type: "hello", protocol: 1 }));
  });
}

function jsonCollector(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    for (const wake of waiters) wake();
  });
  const waitFor = (predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 2_000) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const inspect = () => {
      const found = messages.find(predicate);
      if (!found) return;
      clearTimeout(timeout);
      waiters.delete(inspect);
      resolve(found);
    };
    const timeout = setTimeout(() => {
      waiters.delete(inspect);
      reject(new Error(`timed out waiting for message; received ${JSON.stringify(messages)}`));
    }, timeoutMs);
    waiters.add(inspect);
    inspect();
  });
  return { messages, waitFor };
}

test("Peon WebSocket authentication and connection lifecycle are authoritative for presence", async () => {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);

  const workspaceId = "peon-socket-workspace";
  await query(
    `INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES ($1, 'Peon socket', 'peon-socket', 'owner', $2)`,
    [workspaceId, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Connected Peon", "owner");
  assert.equal(await bindPeon(credential.id, "connected-peon"), true);
  let record = await registry.register({
    peonId: "connected-peon",
    credentialId: credential.id,
    workspaceId,
    name: "Connected Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 4570,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });

  // Registration and fresh application heartbeats are metadata only.
  assert.equal(toView(record).online, false);
  record = (await registry.heartbeat("connected-peon", credential.id, { activeSessions: 0, paused: false, uptimeSec: 1 }))!;
  assert.equal(toView(record).online, false);

  const server = http.createServer();
  // Production attaches the operator socket first. It must ignore this path
  // instead of preempting the Peon handler with a 400 response.
  const liveWss = attachLiveSocket(server);
  const wss = attachPeonSocket(server);
  const port = await listen(server);
  const url = `ws://127.0.0.1:${port}/api/v1/peons/ws`;

  await assert.rejects(open(url, "invalid-token"), /401/);
  const first = await open(url, token);
  assert.equal(toView(record).online, false, "an upgraded socket is not online before hello");
  await sayHello(first);
  assert.equal(toView(record).online, true);
  const legacyState = (await getSessionCatalogStates(workspaceId, record.peonId))[0];
  assert.equal(legacyState?.state, "legacy");
  assert.equal(legacyState?.stale, false, "an online HTTP-reconciled Peon is fresh during rollout");

  const firstClosed = closed(first);
  const second = await open(url, token);
  assert.equal(toView(record).online, true, "the old connection remains authoritative until the new hello");
  await sayHello(second);
  await firstClosed;
  assert.equal(toView(record).online, true, "a stale close must not override its replacement");

  const secondClosed = closed(second);
  await revokeCredentialForPeon(workspaceId, "connected-peon");
  await secondClosed;
  assert.equal(toView(record).online, false);
  await assert.rejects(open(url, token), /401/);

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => liveWss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("canonical durable session catalogs snapshot, commit, acknowledge, and resume", async () => {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);

  const workspaceId = "session-sync-workspace";
  await query(
    `INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES ($1, 'Session sync', 'session-sync', 'owner', $2)`,
    [workspaceId, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Sync Peon", "owner");
  assert.equal(await bindPeon(credential.id, "sync-peon"), true);
  await registry.register({
    peonId: "sync-peon",
    credentialId: credential.id,
    workspaceId,
    name: "Sync Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 4570,
    publicUrl: null,
    protocol: 1,
    // HTTP/API capabilities are intentionally independent from the transport
    // channels advertised by the authenticated WebSocket hello.
    capabilities: ["sessions", "session-pagination-v1"],
    token,
    load: null,
  });
  await upsertSession(workspaceId, "sync-peon", { id: "stale", lastActivityAt: 1 });

  const server = http.createServer();
  const wss = attachPeonSocket(server);
  const port = await listen(server);
  const url = `ws://127.0.0.1:${port}/api/v1/peons/ws`;
  const first = await open(url, token);
  const received = jsonCollector(first);
  first.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "sync-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1"],
    channels: { "session-catalog-v1": { epoch: "catalog-1", revision: 1, earliestSeq: 1, latestSeq: 1 } },
    delivery: {
      epoch: "delivery-1", earliestCursor: "cursor-0", latestCursor: "cursor-1", acknowledgedCursor: null,
      pendingMessages: 2, pendingBytes: 1_024, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: false, recoveredFromCorruption: false, lastError: null,
    },
  }));
  const helloAck = await received.waitFor((message) => message.type === "hello_ack");
  assert.deepEqual(helloAck.capabilities, ["session-catalog-v1", "durable-delivery-v1"]);
  const request = await received.waitFor((message) => message.type === "session_catalog_snapshot_request");
  assert.equal(request.limit, 100);
  const requestId = String(request.requestId);

  // Snapshot-covered durable events can have catalog sequences older than an
  // earlier delivery. Preserve delivery order and let the snapshot barrier
  // determine that both events are safe to commit as covered replays.
  first.send(JSON.stringify({
    type: "durable_message", epoch: "delivery-1", cursor: "cursor-0",
    messageId: "00000000-0000-4000-8000-000000000000", priority: "normal",
    payload: {
      type: "session_catalog_event", epoch: "catalog-1", seq: 1, revision: 1,
      session: { id: "created-live", title: "Created live", status: "running", lastActivityAt: 20 },
    },
  }));
  first.send(JSON.stringify({
    type: "durable_message", epoch: "delivery-1", cursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000001", priority: "normal",
    payload: {
      type: "session_catalog_event", epoch: "catalog-1", seq: 0, revision: 0,
      session: { id: "from-snapshot", title: "Snapshot", status: "running", lastActivityAt: 10 },
    },
  }));
  first.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId, epoch: "catalog-1", revision: 1, barrierSeq: 1,
    sessions: [
      { id: "from-snapshot", title: "Snapshot", status: "running", lastActivityAt: 10 },
      { id: "created-live", title: "Created live", status: "running", lastActivityAt: 20 },
    ],
    nextCursor: "page-2", hasMore: true,
  }));
  const nextRequest = await received.waitFor((message) => message.type === "session_catalog_snapshot_request" && message.cursor === "page-2");
  assert.equal(nextRequest.requestId, requestId);
  first.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId, epoch: "catalog-1", revision: 1, barrierSeq: 1,
    sessions: [], nextCursor: null, hasMore: false,
  }));
  await received.waitFor((message) => message.type === "durable_ack" && message.cursor === "cursor-1");
  await received.waitFor((message) => message.type === "session_catalog_ack" && message.acknowledgedSeq === 1);

  assert.deepEqual(
    (await listSessions({ peonId: "sync-peon", limit: 10, offset: 0 })).sessions.map((session) => session.sessionId),
    ["created-live", "from-snapshot"],
  );

  const checkpoint = await query<{
    catalog_epoch: string; acknowledged_seq: number; delivery_epoch: string; acknowledged_cursor: string; status: string;
  }>(
    `SELECT catalog_epoch, acknowledged_seq, delivery_epoch, acknowledged_cursor, status
     FROM peon_session_sync WHERE peon_id = $1`,
    ["sync-peon"],
  );
  assert.deepEqual(checkpoint.rows[0], {
    catalog_epoch: "catalog-1", acknowledged_seq: 1,
    delivery_epoch: "delivery-1", acknowledged_cursor: "cursor-1", status: "ready",
  });
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM peon_session_inbox WHERE peon_id='sync-peon'`,
  )).rows[0]?.count, 2);
  const catalogState = (await getSessionCatalogStates(workspaceId, "sync-peon"))[0];
  assert.equal(catalogState?.online, true);
  assert.equal(catalogState?.state, "ready");
  assert.equal(catalogState?.stale, false);
  assert.equal(catalogState?.catalogRevision, 1);
  assert.equal(catalogState?.deliveryCommitted, true);
  assert.equal(typeof catalogState?.updatedAt, "number");

  const firstClosed = closed(first);
  first.close();
  await firstClosed;
  const second = await open(url, token);
  const resumed = jsonCollector(second);
  second.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "sync-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1"],
    channels: { "session-catalog-v1": { epoch: "catalog-1", revision: 1, earliestSeq: 1, latestSeq: 1 } },
    delivery: {
      // Simulate a restart after Overseer committed cursor-1 but before Peon
      // persisted that acknowledgement. Processing hello_ack removes cursor-1,
      // so cursor-2 is correctly the first frame sent on this connection.
      epoch: "delivery-1", earliestCursor: "cursor-1", latestCursor: "cursor-2", acknowledgedCursor: null,
      pendingMessages: 2, pendingBytes: 512, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: true, recoveredFromCorruption: false, lastError: null,
    },
  }));
  const resumeAck = await resumed.waitFor((message) => message.type === "hello_ack");
  assert.deepEqual(resumeAck.channels, { "session-catalog-v1": { epoch: "catalog-1", acknowledgedSeq: 1 } });
  assert.deepEqual(resumeAck.delivery, { epoch: "delivery-1", acknowledgedCursor: "cursor-1" });
  assert.equal(resumed.messages.some((message) => message.type === "session_catalog_snapshot_request"), false);
  second.send(JSON.stringify({
    type: "durable_message", epoch: "delivery-1", cursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000003", priority: "normal",
    payload: {
      type: "session_catalog_event", epoch: "catalog-1", seq: 3, revision: 3,
      session: { id: "must-not-commit", status: "running" },
    },
  }));
  const recoveryRequest = await resumed.waitFor((message) => message.type === "session_catalog_snapshot_request");
  second.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId: recoveryRequest.requestId,
    epoch: "catalog-1", revision: 3, barrierSeq: 3,
    sessions: [
      { id: "from-snapshot", title: "Snapshot", status: "running", lastActivityAt: 10 },
      { id: "created-live", title: "Created live", status: "running", lastActivityAt: 20 },
    ],
    nextCursor: null, hasMore: false,
  }));
  await resumed.waitFor((message) => message.type === "durable_ack" && message.cursor === "cursor-2");
  await resumed.waitFor((message) => message.type === "session_catalog_ack" && message.acknowledgedSeq === 3);
  assert.equal((await listSessions({ peonId: "sync-peon", limit: 10, offset: 0 })).sessions.some(
    (session) => session.sessionId === "must-not-commit"), false);

  const epochChanged = await open(url, token);
  const epochMessages = jsonCollector(epochChanged);
  epochChanged.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "sync-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1"],
    channels: { "session-catalog-v1": { epoch: "catalog-2", revision: 0, earliestSeq: 0, latestSeq: 0 } },
    delivery: {
      epoch: "delivery-2", earliestCursor: null, latestCursor: null, acknowledgedCursor: null,
      pendingMessages: 0, pendingBytes: 0, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: true, recoveredFromCorruption: false, lastError: null,
    },
  }));
  const changedAck = await epochMessages.waitFor((message) => message.type === "hello_ack");
  assert.deepEqual(changedAck.channels, {});
  assert.equal("delivery" in changedAck, false);
  const freshRequest = await epochMessages.waitFor((message) => message.type === "session_catalog_snapshot_request");
  const cancelled = new Promise<{ code: number; reason: string }>((resolve) => {
    epochChanged.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  epochChanged.send(JSON.stringify({ type: "session_catalog_snapshot_cancelled", requestId: freshRequest.requestId }));
  assert.deepEqual(await cancelled, { code: 1002, reason: "session catalog snapshot cancelled" });
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("catalog epoch rollover drains superseded durable events without reconnect poisoning", async () => {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  const workspaceId = "epoch-rollover-workspace";
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Epoch rollover','epoch-rollover','owner',$2)`,
    [workspaceId, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Epoch Peon", "owner");
  assert.equal(await bindPeon(credential.id, "epoch-peon"), true);
  await registry.register({
    peonId: "epoch-peon", credentialId: credential.id, workspaceId, name: "Epoch Peon",
    hostname: null, address: "127.0.0.1", controlPort: 4570, publicUrl: null, protocol: 1,
    capabilities: [], token, load: null,
  });

  const server = http.createServer();
  const wss = attachPeonSocket(server);
  const port = await listen(server);
  const url = `ws://127.0.0.1:${port}/api/v1/peons/ws`;

  const initial = await open(url, token);
  const initialMessages = jsonCollector(initial);
  initial.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "epoch-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1"],
    channels: { "session-catalog-v1": { epoch: "catalog-old", revision: 0, earliestSeq: 0, latestSeq: 0 } },
    delivery: {
      epoch: "delivery-stable", earliestCursor: null, latestCursor: null, acknowledgedCursor: null,
      pendingMessages: 0, pendingBytes: 0, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: false, recoveredFromCorruption: false, lastError: null,
    },
  }));
  const initialRequest = await initialMessages.waitFor((message) => message.type === "session_catalog_snapshot_request");
  initial.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId: initialRequest.requestId,
    epoch: "catalog-old", revision: 0, barrierSeq: 0,
    sessions: [{ id: "retired", title: "Retired", status: "completed", lastActivityAt: 1 }],
    nextCursor: null, hasMore: false,
  }));
  await initialMessages.waitFor((message) => message.type === "session_catalog_ack");
  initial.close();
  await closed(initial);

  const rollover = await open(url, token);
  const rolloverMessages = jsonCollector(rollover);
  const unexpectedlyClosed = new Promise<never>((_, reject) => {
    rollover.once("close", (code, reason) => reject(new Error(`rollover socket closed ${code}: ${reason.toString()}`)));
  });
  rollover.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "epoch-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1"],
    channels: { "session-catalog-v1": { epoch: "catalog-new", revision: 0, earliestSeq: 0, latestSeq: 0 } },
    delivery: {
      epoch: "delivery-stable", earliestCursor: "cursor-1", latestCursor: "cursor-1", acknowledgedCursor: null,
      pendingMessages: 1, pendingBytes: 256, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: true, recoveredFromCorruption: false, lastError: null,
    },
  }));
  const helloAck = await rolloverMessages.waitFor((message) => message.type === "hello_ack");
  assert.deepEqual(helloAck.channels, {});
  assert.deepEqual(helloAck.delivery, { epoch: "delivery-stable", acknowledgedCursor: null });
  const rolloverRequest = await rolloverMessages.waitFor((message) => message.type === "session_catalog_snapshot_request");

  // This message was durably queued before the catalog was rebuilt. Its cursor
  // still owns the global delivery frontier, but its old-epoch mutation is now
  // superseded by the new authoritative snapshot.
  rollover.send(JSON.stringify({
    type: "durable_message", epoch: "delivery-stable", cursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000020", priority: "normal",
    payload: {
      type: "session_catalog_event", epoch: "catalog-old", seq: 1, revision: 1,
      session: { id: "must-not-return", title: "Stale", status: "running", lastActivityAt: 2 },
    },
  }));
  rollover.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId: rolloverRequest.requestId,
    epoch: "catalog-new", revision: 0, barrierSeq: 0,
    sessions: [{ id: "current", title: "Current", status: "running", lastActivityAt: 3 }],
    nextCursor: null, hasMore: false,
  }));

  await Promise.race([
    rolloverMessages.waitFor((message) => message.type === "durable_ack" && message.cursor === "cursor-1"),
    unexpectedlyClosed,
  ]);
  const sessions = (await listSessions({ peonId: "epoch-peon", limit: 10, offset: 0 })).sessions;
  assert.deepEqual(sessions.map((session) => session.sessionId), ["current"]);
  const checkpoint = await query<{
    catalog_epoch: string; acknowledged_seq: number; delivery_epoch: string; acknowledged_cursor: string; status: string;
  }>(
    `SELECT catalog_epoch,acknowledged_seq,delivery_epoch,acknowledged_cursor,status
       FROM peon_session_sync WHERE peon_id='epoch-peon'`,
  );
  assert.deepEqual(checkpoint.rows[0], {
    catalog_epoch: "catalog-new", acknowledged_seq: 0,
    delivery_epoch: "delivery-stable", acknowledged_cursor: "cursor-1", status: "ready",
  });

  // Replaceable session summaries may coalesce before transmission, leaving a
  // deliberate catalog sequence gap while retaining one ordered delivery
  // cursor. The receiver fences that event behind a new snapshot instead of
  // closing and retrying the same poison message forever.
  rollover.send(JSON.stringify({
    type: "durable_message", epoch: "delivery-stable", cursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000021", priority: "normal",
    payload: {
      type: "session_catalog_event", epoch: "catalog-new", seq: 2, revision: 2,
      session: { id: "latest", title: "Coalesced latest", status: "running", lastActivityAt: 4 },
    },
  }));
  const recoveryRequest = await Promise.race([
    rolloverMessages.waitFor((message) => message.type === "session_catalog_snapshot_request"
      && message.requestId !== rolloverRequest.requestId),
    unexpectedlyClosed,
  ]);
  rollover.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId: recoveryRequest.requestId,
    epoch: "catalog-new", revision: 2, barrierSeq: 2,
    sessions: [{ id: "latest", title: "Coalesced latest", status: "running", lastActivityAt: 4 }],
    nextCursor: null, hasMore: false,
  }));
  await Promise.race([
    rolloverMessages.waitFor((message) => message.type === "durable_ack" && message.cursor === "cursor-2"),
    unexpectedlyClosed,
  ]);
  assert.deepEqual(
    (await listSessions({ peonId: "epoch-peon", limit: 10, offset: 0 })).sessions.map((session) => session.sessionId),
    ["latest"],
  );
  const recovered = await query<{ acknowledged_seq: number; acknowledged_cursor: string; status: string }>(
    `SELECT acknowledged_seq,acknowledged_cursor,status FROM peon_session_sync WHERE peon_id='epoch-peon'`,
  );
  assert.deepEqual(recovered.rows[0], { acknowledged_seq: 2, acknowledged_cursor: "cursor-2", status: "ready" });

  rollover.close();
  await closed(rollover);
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("session and project catalogs share one ordered durable delivery frontier", async () => {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  const workspaceId = "multi-catalog-workspace";
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Multi catalog','multi-catalog','owner',$2)`,
    [workspaceId, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Multi catalog Peon", "owner");
  assert.equal(await bindPeon(credential.id, "multi-catalog-peon"), true);
  await registry.register({
    peonId: "multi-catalog-peon", credentialId: credential.id, workspaceId, name: "Multi catalog Peon",
    hostname: null, address: "127.0.0.1", controlPort: 4570, publicUrl: null, protocol: 1,
    capabilities: [], token, load: null,
  });

  const server = http.createServer();
  const wss = attachPeonSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  const received = jsonCollector(ws);
  ws.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "multi-catalog-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "project-catalog-v1"],
    channels: {
      "session-catalog-v1": { epoch: "sessions", revision: 1, earliestSeq: 0, latestSeq: 1 },
      "project-catalog-v1": { epoch: "projects", revision: 0, earliestSeq: 0, latestSeq: 0 },
    },
    delivery: {
      epoch: "delivery", earliestCursor: "cursor-0", latestCursor: "cursor-1", acknowledgedCursor: null,
      pendingMessages: 2, pendingBytes: 1_024, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: false, recoveredFromCorruption: false, lastError: null,
    },
  }));
  const ack = await received.waitFor((message) => message.type === "hello_ack");
  assert.deepEqual(ack.capabilities, ["session-catalog-v1", "durable-delivery-v1", "project-catalog-v1"]);
  const sessionRequest = await received.waitFor((message) => message.type === "session_catalog_snapshot_request");
  const projectRequest = await received.waitFor((message) => message.type === "project_catalog_snapshot_request");

  ws.send(JSON.stringify({
    type: "durable_message", epoch: "delivery", cursor: "cursor-0",
    messageId: "00000000-0000-4000-8000-000000000010", priority: "normal",
    payload: {
      type: "project_catalog_event", epoch: "projects", seq: 0, revision: 0,
      project: { projectId: "project-1", key: "project", name: "Project", dir: "/work/project", metadata: null },
    },
  }));
  ws.send(JSON.stringify({
    type: "durable_message", epoch: "delivery", cursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000011", priority: "normal",
    payload: {
      type: "session_catalog_event", epoch: "sessions", seq: 1, revision: 1,
      session: { id: "session-1", projectId: "project-1", projectKey: "project", status: "running" },
    },
  }));
  ws.send(JSON.stringify({
    type: "session_catalog_snapshot_page", requestId: sessionRequest.requestId,
    epoch: "sessions", revision: 1, barrierSeq: 0, sessions: [], nextCursor: null, hasMore: false,
  }));
  await received.waitFor((message) => message.type === "session_catalog_ack");
  assert.equal(received.messages.some((message) => message.type === "durable_ack"), false,
    "delivery cannot advance while another negotiated catalog snapshot is incomplete");
  ws.send(JSON.stringify({
    type: "project_catalog_snapshot_page", requestId: projectRequest.requestId,
    epoch: "projects", revision: 0, barrierSeq: 0,
    projects: [{
      projectId: "project-1",
      key: "project",
      name: "Project",
      dir: "/work/project",
      metadata: null,
      quickLinks: [{ id: "docs", title: "Docs", url: "https://example.test/docs", order: 0 }],
    }],
    nextCursor: null, hasMore: false,
  }));
  await received.waitFor((message) => message.type === "durable_ack" && message.cursor === "cursor-1");
  await received.waitFor((message) => message.type === "project_catalog_ack" && message.acknowledgedSeq === 0);
  assert.equal((await listIndexedProjects("multi-catalog-peon"))[0]?.projectId, "project-1");
  assert.equal((await listIndexedProjects("multi-catalog-peon"))[0]?.quickLinks?.[0]?.title, "Docs");
  assert.equal((await listSessions({ peonId: "multi-catalog-peon", limit: 10, offset: 0 })).sessions[0]?.sessionId, "session-1");
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count, 2);

  ws.close();
  await closed(ws);
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("canonical capabilities are accepted only as a pair", async () => {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  const workspaceId = "strict-sync-workspace";
  await query(
    `INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES ($1, 'Strict sync', 'strict-sync', 'owner', $2)`,
    [workspaceId, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Strict Peon", "owner");
  assert.equal(await bindPeon(credential.id, "strict-peon"), true);
  await registry.register({
    peonId: "strict-peon", credentialId: credential.id, workspaceId, name: "Strict Peon",
    hostname: null, address: "127.0.0.1", controlPort: 4570, publicUrl: null, protocol: 1,
    capabilities: ["session-catalog-v1", "durable-delivery-v1"], token, load: null,
  });

  const server = http.createServer();
  const wss = attachPeonSocket(server);
  const port = await listen(server);
  const ws = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  const received = jsonCollector(ws);
  ws.send(JSON.stringify({ type: "hello", protocol: 1, capabilities: ["session-catalog-v1"] }));
  const ack = await received.waitFor((message) => message.type === "hello_ack");
  assert.deepEqual(ack.capabilities, []);
  assert.equal(received.messages.some((message) => message.type === "session_catalog_snapshot_request"), false);
  ws.close();
  await closed(ws);

  const gapped = await open(`ws://127.0.0.1:${port}/api/v1/peons/ws`, token);
  const gappedMessages = jsonCollector(gapped);
  gapped.send(JSON.stringify({
    type: "hello", protocol: 1, peonId: "strict-peon",
    capabilities: ["session-catalog-v1", "durable-delivery-v1"],
    channels: { "session-catalog-v1": { epoch: "catalog", revision: 1, earliestSeq: 1, latestSeq: 1 } },
    delivery: {
      epoch: "delivery", earliestCursor: "cursor-1", latestCursor: "cursor-1", acknowledgedCursor: null,
      pendingMessages: 1, pendingBytes: 100, maxMessages: 5_000, maxBytes: 33_554_432,
      backpressured: false, negotiated: true, recoveredFromCorruption: false, lastError: null,
    },
  }));
  await gappedMessages.waitFor((message) => message.type === "session_catalog_snapshot_request");
  const gapClosed = new Promise<{ code: number; reason: string }>((resolve) => {
    gapped.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  gapped.send(JSON.stringify({
    type: "durable_message", epoch: "delivery", cursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000004", priority: "normal",
    payload: { type: "session_catalog_event", epoch: "catalog", seq: 1, revision: 1, session: { id: "gap" } },
  }));
  assert.deepEqual(await gapClosed, { code: 1002, reason: "durable delivery cursor gap" });

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
