import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { initDb, query, setPool } from "./infrastructure/db/index.js";
import { consumeWebSocketTicket, issueDevice, issueWebSocketTicket, verifyDeviceToken } from "./modules/auth/index.js";
import { createWorkspace } from "./workspaces.js";
import { registry } from "./registry.js";
import { attachLiveSocket, parseSse } from "./liveSocket.js";
import { resetAudioFocus } from "./modules/presence/index.js";
import { listSessions, upsertSession } from "./sessionIndex.js";
import { broadcast, readEventsSince } from "./eventLog.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("an idle Postgres connection error is handled without crashing the process", async () => {
  // Use the real EventEmitter-based Pool here; pg-mem's compatible test pool has
  // `.on()` but intentionally does not implement `.emit()`.
  const pool = new pg.Pool();
  setPool(pool);

  // pg-pool uses this EventEmitter path when an idle TCP connection disappears.
  // An `error` event without a listener throws synchronously and kills Node.
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => pool.emit("error", new Error("simulated idle disconnect")));
  } finally {
    console.error = originalError;
    await pool.end();
  }
});

function messageCollector(ws: WebSocket): {
  messages: Record<string, unknown>[];
  waitFor: (predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<(message: Record<string, unknown>) => void>();
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    messages.push(message);
    for (const listener of listeners) listener(message);
  });
  return {
    messages,
    waitFor(predicate, timeoutMs = 3000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(onMessage);
          reject(new Error(`timed out waiting for WebSocket message; received ${JSON.stringify(messages)}`));
        }, timeoutMs);
        const onMessage = (message: Record<string, unknown>) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          listeners.delete(onMessage);
          resolve(message);
        };
        listeners.add(onMessage);
      });
    },
  };
}

test("SSE parser accepts CRLF and preserves multi-line data", () => {
  assert.deepEqual(parseSse("event: event\r\nid: 42\r\ndata: one\r\ndata: two"), { event: "event", id: "42", data: "one\ntwo" });
  assert.deepEqual(parseSse("data: no-id"), { event: null, id: null, data: "no-id" });
  assert.equal(parseSse(": keepalive"), null);
});

test("WebSocket tickets are short-lived credentials that can only be consumed once", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('ticket-user','ticket@example.test',1)`);
  const { token } = await issueDevice("ticket-user", "test", { ip: null, userAgent: null });
  const auth = await verifyDeviceToken(token);
  assert.ok(auth);
  const issued = await issueWebSocketTicket(auth);

  assert.equal((await consumeWebSocketTicket(issued.ticket))?.userId, "ticket-user");
  assert.equal(await consumeWebSocketTicket(issued.ticket), null);
});

test("session live index rejects a stale reconcile after a terminal update", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await upsertSession("workspace-stale", "peon-stale", {
    id: "session-stale",
    status: "completed",
    promptPreview: "authoritative opening",
    startedAt: 100,
    lastActivityAt: 300,
    endedAt: 300,
  });
  // This simulates an older /sessions reconcile response landing after the
  // pushed completion event.
  await upsertSession("workspace-stale", "peon-stale", {
    id: "session-stale",
    status: "running",
    promptPreview: "stale opening",
    startedAt: 100,
    lastActivityAt: 200,
    endedAt: null,
  });
  const { sessions } = await listSessions({ peonId: "peon-stale", limit: 10, offset: 0 });
  assert.equal(sessions[0]?.status, "completed");
  assert.equal(sessions[0]?.endedAt, 300);
  assert.equal(sessions[0]?.promptPreview, "authoritative opening");
  const events = await readEventsSince("workspace-stale", 0);
  assert.equal(events.length, 1, "a rejected stale row must not be broadcast");
});

test("WebSocket handshake and session tails survive ordering and replacement races", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3)`, ["user-1", "tank@example.test", Date.now()]);
  const workspace = await createWorkspace("Tank", "user-1");
  const { token } = await issueDevice("user-1", "test", { ip: null, userAgent: null });
  const auth = await verifyDeviceToken(token);
  assert.ok(auth);
  const { ticket } = await issueWebSocketTicket(auth);

  let replacementStreams = 0;
  let crlfResumeHeader: string | undefined;
  let replacementResumeHeader: string | undefined;
  const peon = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://peon.test").pathname;
    res.setHeader("Content-Type", "text/event-stream");
    if (path.endsWith("/sessions/crlf/stream")) {
      crlfResumeHeader = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined;
      // Split CRLF's delimiter across writes to exercise the incremental framer.
      res.write("event: event\r\nid: 7\r\ndata: {\"kind\":\"crlf\"}\r\n");
      return setTimeout(() => res.end("\r\n"), 5);
    }
    if (path.endsWith("/sessions/replacement/stream")) {
      replacementResumeHeader = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined;
      replacementStreams += 1;
      res.write(`event: event\ndata: {"stream":${replacementStreams}}\n\n`);
      return;
    }
    if (path.endsWith("/sessions/failure/stream")) {
      res.statusCode = 503;
      return res.end("unavailable");
    }
    res.statusCode = 404;
    res.end();
  });
  const peonPort = await listen(peon);
  await registry.register({
    peonId: "peon-1",
    credentialId: "credential-1",
    workspaceId: workspace.id,
    name: "stub",
    hostname: null,
    address: "127.0.0.1",
    controlPort: peonPort,
    protocol: 1,
    capabilities: ["transcript-pagination-v1"],
    token: "peon-token",
    load: null,
  });
  const largeIndexedSession = {
    id: "large-snapshot-session",
    projectKey: null,
    title: "Large raw session",
    transcript: "x".repeat(2 * 1024 * 1024),
  };
  await upsertSession(workspace.id, "peon-1", largeIndexedSession);

  const appServer = http.createServer();
  const wss = attachLiveSocket(appServer);
  const appPort = await listen(appServer);
  const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws?ticket=${encodeURIComponent(ticket)}`);
  const collector = messageCollector(ws);

  try {
    await once(ws, "open");
    // These intentionally arrive while credential verification is still pending,
    // and subscribe is intentionally adjacent to hello.
    ws.send(JSON.stringify({ type: "hello", workspaceId: workspace.id, cursor: 0 }));
    ws.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "crlf", lastEventId: "event-6" }));
    const snapshot = await collector.waitFor((message) => message.type === "snapshot");
    assert.equal("sessions" in snapshot, false, "REST-owned session lists must not be duplicated in the WebSocket handshake");
    assert.equal("peons" in snapshot, false, "REST-owned Peon lists must not be duplicated in the WebSocket handshake");
    assert.deepEqual(snapshot.peonPresence, [{
      peonId: "peon-1",
      name: "stub",
      online: false,
      controlConnected: false,
      controlConnectedAt: null,
    }], "socket snapshot owns initial connection state without duplicating full Peon records");
    assert.ok(JSON.stringify(snapshot).length < 10_000, "REST records must not inflate the WebSocket snapshot");
    broadcast({ workspaceId: workspace.id, peonId: "peon-1", kind: "peon", payload: { peonId: "peon-1", name: "stub", online: true } });
    const peonPresence = await collector.waitFor((message) => message.type === "peon" && (message.payload as { peonId?: string })?.peonId === "peon-1");
    assert.equal((peonPresence.payload as { online?: boolean }).online, true, "Peon connection presence must fan out immediately");
    const crlf = await collector.waitFor((message) => message.type === "tail" && message.sessionId === "crlf");
    assert.equal(crlf.data, "{\"kind\":\"crlf\"}");
    assert.equal(crlf.id, "7");
    assert.equal(crlfResumeHeader, "event-6", "durable subscriptions resume after the paginated snapshot");

    ws.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "replacement" }));
    await collector.waitFor((message) => message.type === "tail" && message.sessionId === "replacement" && message.data === '{"stream":1}');
    assert.equal(replacementResumeHeader, undefined, "subscriptions without a durable boundary remain backward compatible");
    const replaceAt = collector.messages.length;
    ws.send(JSON.stringify({ type: "unsubscribe", sessionId: "replacement" }));
    ws.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "replacement" }));
    await collector.waitFor((message) => message.type === "tail" && message.sessionId === "replacement" && message.data === '{"stream":2}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      collector.messages.slice(replaceAt).some((message) => message.type === "tailEnd" && message.sessionId === "replacement"),
      false,
      "the retired stream must not terminate its replacement",
    );

    const failureAt = collector.messages.length;
    ws.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "failure" }));
    await collector.waitFor((message) => message.type === "tailError" && message.sessionId === "failure");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const terminals = collector.messages
      .slice(failureAt)
      .filter((message) => (message.type === "tailError" || message.type === "tailEnd") && message.sessionId === "failure");
    assert.deepEqual(terminals.map((message) => message.type), ["tailError"]);
  } finally {
    ws.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await closeServer(appServer);
    await closeServer(peon);
  }
});

test("presence is Overseer-only, route-based, ACL-filtered, and cleared on disconnect", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  const now = Date.now();
  await query(
    `INSERT INTO users (id, email, github_login, created_at) VALUES
       ('presence-owner', 'owner@example.test', 'owner', $1),
       ('presence-viewer', 'viewer@example.test', 'viewer', $1),
       ('presence-member', 'member@example.test', 'member', $1)`,
    [now],
  );
  const workspace = await createWorkspace("Presence", "presence-owner");
  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES
       ($1, 'presence-viewer', 'owner', $2),
       ($1, 'presence-member', 'member', $2)`,
    [workspace.id, now],
  );
  await registry.register({
    peonId: "presence-peon",
    credentialId: "presence-credential",
    workspaceId: workspace.id,
    name: "presence",
    hostname: null,
    address: "127.0.0.1",
    // Nothing listens here: presence must never need a Peon request.
    controlPort: 9,
    protocol: 1,
    capabilities: [],
    token: "unused",
    load: null,
  });
  await upsertSession(workspace.id, "presence-peon", {
    id: "presence-session",
    projectKey: "secret-project",
    status: "running",
    startedAt: now,
    lastActivityAt: now,
  });
  await query(
    `INSERT INTO workspace_member_peon_access (workspace_id, user_id, peon_id, granted_at, granted_by)
     VALUES ($1, 'presence-member', 'presence-peon', $2, 'presence-owner')`,
    [workspace.id, now],
  );

  const appServer = http.createServer();
  const wss = attachLiveSocket(appServer);
  const appPort = await listen(appServer);
  const sockets: WebSocket[] = [];
  async function connect(userId: string) {
    const { token } = await issueDevice(userId, "presence-test", { ip: null, userAgent: null });
    const auth = await verifyDeviceToken(token);
    assert.ok(auth);
    const { ticket } = await issueWebSocketTicket(auth);
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(ws);
    const collector = messageCollector(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", workspaceId: workspace.id, cursor: 0 }));
    await collector.waitFor((message) => message.type === "snapshot");
    return { ws, collector };
  }

  try {
    const owner = await connect("presence-owner");
    const viewer = await connect("presence-viewer");
    const member = await connect("presence-member");

    viewer.ws.send(JSON.stringify({
      type: "presence:set",
      scope: "session",
      peonId: "presence-peon",
      sessionId: "presence-session",
    }));
    const ownerSession = await owner.collector.waitFor((message) =>
      message.type === "presence"
      && Array.isArray(message.presence)
      && message.presence.some((entry) => (entry as { userId?: string; scope?: string }).userId === "presence-viewer"
        && (entry as { scope?: string }).scope === "session"),
    );
    assert.ok(ownerSession);
    const restricted = await member.collector.waitFor((message) => message.type === "presence");
    assert.equal(
      (restricted.presence as Array<{ userId: string }>).some((entry) => entry.userId === "presence-viewer"),
      false,
      "a member without project access must not see session presence",
    );

    viewer.ws.send(JSON.stringify({ type: "presence:set", scope: "peon", peonId: "presence-peon" }));
    const memberPeon = await member.collector.waitFor((message) =>
      message.type === "presence"
      && Array.isArray(message.presence)
      && message.presence.some((entry) => (entry as { userId?: string; scope?: string }).userId === "presence-viewer"
        && (entry as { scope?: string }).scope === "peon"),
    );
    assert.ok(memberPeon, "Peon-level presence is visible with Peon access");

    const disconnectAt = owner.collector.messages.length;
    viewer.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterDisconnect = owner.collector.messages
      .slice(disconnectAt)
      .filter((message) => message.type === "presence")
      .at(-1);
    assert.ok(afterDisconnect, "disconnect broadcasts a fresh presence snapshot");
    assert.equal(
      (afterDisconnect.presence as Array<{ userId: string }>).some((entry) => entry.userId === "presence-viewer"),
      false,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await closeServer(appServer);
  }
});

test("notification sound follows the client the operator picked up last", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  resetAudioFocus();
  await query(`INSERT INTO users (id, email, created_at) VALUES ('audio-user', 'audio@example.test', $1)`, [Date.now()]);
  const workspace = await createWorkspace("Audio", "audio-user");

  const appServer = http.createServer();
  const wss = attachLiveSocket(appServer);
  const appPort = await listen(appServer);
  const sockets: WebSocket[] = [];
  async function connect(clientId: string | null) {
    const { token } = await issueDevice("audio-user", "audio-test", { ip: null, userAgent: null });
    const auth = await verifyDeviceToken(token);
    assert.ok(auth);
    const { ticket } = await issueWebSocketTicket(auth);
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(ws);
    const collector = messageCollector(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", workspaceId: workspace.id, cursor: 0, ...(clientId ? { clientId } : {}) }));
    await collector.waitFor((message) => message.type === "snapshot");
    return { ws, collector };
  }
  const owns = (client: { collector: ReturnType<typeof messageCollector> }, primary: boolean) =>
    client.collector.waitFor((message) => message.type === "audio" && message.primary === primary);

  try {
    const desktop = await connect("desktop-tab");
    await owns(desktop, true);

    // The phone joins: it is the client in the operator's hands now.
    const phone = await connect("phone-tab");
    await owns(phone, true);
    await owns(desktop, false);

    // A second socket of the same desktop tab (a fleet-dashboard workspace) is
    // not a new client and must not take the sound back.
    const dashboard = await connect("desktop-tab");
    await owns(dashboard, false);
    assert.equal(phone.collector.messages.filter((message) => message.type === "audio").at(-1)?.primary, true);

    // Phone goes into a pocket — the tab hides — and the desktop speaks again.
    phone.ws.send(JSON.stringify({ type: "presence:set", scope: "workspace", active: false }));
    await owns(desktop, true);
    await owns(phone, false);

    // Closing the phone leaves the desktop as it was: still the one making noise.
    phone.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(desktop.collector.messages.filter((message) => message.type === "audio").at(-1)?.primary, true);

    // An explicit gesture on the dashboard socket claims the sound for its tab.
    dashboard.ws.send(JSON.stringify({ type: "audio:claim" }));
    await owns(dashboard, true);

    // A native app going to the background reports it without disconnecting.
    const native = await connect("mobile-install");
    await owns(native, true);
    native.ws.send(JSON.stringify({ type: "audio:release" }));
    await owns(desktop, true);
    await owns(native, false);
    native.ws.send(JSON.stringify({ type: "audio:claim" }));
    await owns(native, true);

    // A client that never identifies itself is told nothing and takes nothing:
    // it cannot be silenced, so it must not silence a client that can be.
    const legacy = await connect(null);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(legacy.collector.messages.filter((message) => message.type === "audio"), []);
    assert.equal(native.collector.messages.filter((message) => message.type === "audio").at(-1)?.primary, true);
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await closeServer(appServer);
  }
});
