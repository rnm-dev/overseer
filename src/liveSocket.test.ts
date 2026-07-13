import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { initDb, query, setPool } from "./db.js";
import { issueDevice } from "./auth.js";
import { createWorkspace } from "./workspaces.js";
import { registry } from "./registry.js";
import { attachLiveSocket, parseSse } from "./liveSocket.js";
import { listSessions, upsertSession } from "./sessionIndex.js";
import { readEventsSince } from "./eventLog.js";

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
  assert.deepEqual(parseSse("event: event\r\ndata: one\r\ndata: two"), { event: "event", data: "one\ntwo" });
  assert.equal(parseSse(": keepalive"), null);
});

test("session live index rejects a stale reconcile after a terminal update", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await upsertSession("workspace-stale", "peon-stale", {
    id: "session-stale",
    status: "completed",
    startedAt: 100,
    lastActivityAt: 300,
    endedAt: 300,
  });
  // This simulates an older /sessions reconcile response landing after the
  // pushed completion event.
  await upsertSession("workspace-stale", "peon-stale", {
    id: "session-stale",
    status: "running",
    startedAt: 100,
    lastActivityAt: 200,
    endedAt: null,
  });
  const { sessions } = await listSessions({ peonId: "peon-stale", limit: 10, offset: 0 });
  assert.equal(sessions[0]?.status, "completed");
  assert.equal(sessions[0]?.endedAt, 300);
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

  let replacementStreams = 0;
  const peon = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://peon.test").pathname;
    res.setHeader("Content-Type", "text/event-stream");
    if (path.endsWith("/sessions/crlf/stream")) {
      // Split CRLF's delimiter across writes to exercise the incremental framer.
      res.write("event: event\r\ndata: {\"kind\":\"crlf\"}\r\n");
      return setTimeout(() => res.end("\r\n"), 5);
    }
    if (path.endsWith("/sessions/replacement/stream")) {
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
    capabilities: [],
    token: "peon-token",
    load: null,
  });

  const appServer = http.createServer();
  const wss = attachLiveSocket(appServer);
  const appPort = await listen(appServer);
  const ws = new WebSocket(`ws://127.0.0.1:${appPort}/api/ws?token=${encodeURIComponent(token)}`);
  const collector = messageCollector(ws);

  try {
    await once(ws, "open");
    // These intentionally arrive while credential verification is still pending,
    // and subscribe is intentionally adjacent to hello.
    ws.send(JSON.stringify({ type: "hello", workspaceId: workspace.id, cursor: 0 }));
    ws.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "crlf" }));
    await collector.waitFor((message) => message.type === "snapshot");
    const crlf = await collector.waitFor((message) => message.type === "tail" && message.sessionId === "crlf");
    assert.equal(crlf.data, "{\"kind\":\"crlf\"}");

    ws.send(JSON.stringify({ type: "subscribe", peonId: "peon-1", sessionId: "replacement" }));
    await collector.waitFor((message) => message.type === "tail" && message.sessionId === "replacement" && message.data === '{"stream":1}');
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
