import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import { listSessions, reconcilePeon, upsertSession } from "./sessionIndex.js";

test("session index keeps the opening preview separate from latest activity", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await upsertSession("workspace", "peon", {
    id: "session",
    promptPreview: "opening request",
    lastMessagePreview: "latest response",
    lastActivityAt: 10,
  });

  const { sessions } = await listSessions({ peonId: "peon", limit: 10, offset: 0 });
  assert.equal(sessions[0]?.promptPreview, "opening request");
  assert.equal(sessions[0]?.preview, "latest response");
  assert.equal("raw" in sessions[0]!, false);
});

test("session index filters authors before choosing the newest page", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await upsertSession("workspace", "peon", { id: "other-newest", initiator: "other@example.com", lastActivityAt: 30 });
  await upsertSession("workspace", "peon", { id: "mine-older", initiator: "ME@example.com", lastActivityAt: 10 });
  await upsertSession("workspace", "peon", { id: "mine-newest", initiator: "me@example.com", lastActivityAt: 20 });

  const result = await listSessions({ peonId: "peon", authors: ["me@example.com"], limit: 1, offset: 0 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["mine-newest"]);
});

test("legacy full records derive a bounded opening preview", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await upsertSession("workspace", "peon", {
    id: "legacy",
    prompt: "x".repeat(300),
    lastMessagePreview: "latest response",
    backendSessionId: "detail-only",
  });

  const { sessions } = await listSessions({ peonId: "peon", limit: 10, offset: 0 });
  assert.equal(sessions[0]?.promptPreview, "x".repeat(200));
  assert.equal(sessions[0]?.preview, "latest response");
  const stored = await query<{ raw: Record<string, unknown> }>(
    `SELECT raw FROM sessions WHERE peon_id=$1 AND session_id=$2`,
    ["peon", "legacy"],
  );
  assert.equal(stored.rows[0]?.raw.prompt, undefined);
  assert.equal(stored.rows[0]?.raw.backendSessionId, undefined);
  assert.equal(stored.rows[0]?.raw.promptPreview, "x".repeat(200));
});

test("session list projects a legacy prompt without returning the raw snapshot", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO sessions (peon_id,session_id,raw,synced_at)
     VALUES ($1,$2,$3,$4)`,
    ["peon", "legacy-raw", JSON.stringify({ prompt: "x".repeat(500), transcript: "y".repeat(100_000) }), 1],
  );

  const { sessions } = await listSessions({ peonId: "peon", limit: 10, offset: 0 });
  assert.equal(sessions[0]?.promptPreview, "x".repeat(200));
  assert.equal("raw" in sessions[0]!, false);
});

test("workspace hydration caps each Peon independently and keeps global activity order", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO peons (peon_id,credential_id,workspace_id,name,address,control_port,capabilities,token,registered_at,last_seen)
     VALUES ('p1','c1','ws','One','127.0.0.1',1,'[]','t',1,1),
            ('p2','c2','ws','Two','127.0.0.1',1,'[]','t',1,1)`,
  );
  for (const [peonId, activities] of [["p1", [50, 30, 10]], ["p2", [40, 20, 5]]] as const) {
    for (const activity of activities) {
      await query(
        `INSERT INTO sessions (peon_id,session_id,last_activity_at,raw,synced_at) VALUES ($1,$2,$3,'{}',$3)`,
        [peonId, `${peonId}-${activity}`, activity],
      );
    }
  }

  const result = await listSessions({ workspaceId: "ws", perPeonLimit: 2, limit: 200, offset: 0 });
  assert.equal(result.total, 6);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["p1-50", "p2-40", "p1-30", "p2-20"]);
});

test("Peon collection reconciliation indexes summaries without exposing cached raw data", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sessions: [{
      id: "reconciled",
      status: "running",
      promptPreview: "first message",
      lastMessagePreview: "latest message",
      projectKey: "project",
      projectId: "project-id",
      lastActivityAt: 20,
    }] }));
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  try {
    assert.equal(await reconcilePeon({
      peonId: "peon",
      credentialId: "credential",
      workspaceId: "workspace",
      name: "Peon",
      hostname: null,
      address: "127.0.0.1",
      controlPort: port,
      publicUrl: `http://127.0.0.1:${port}`,
      addressSource: "advertised",
      protocol: 1,
      capabilities: [],
      token: "token",
      connectionPinned: false,
      registeredAt: 1,
      lastSeen: 1,
      load: null,
    }), 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const { sessions } = await listSessions({ peonId: "peon", limit: 10, offset: 0 });
  assert.equal(sessions[0]?.promptPreview, "first message");
  assert.equal(sessions[0]?.preview, "latest message");
  assert.equal("raw" in sessions[0]!, false);
});

test("Peon collection reconciliation removes sessions deleted at the Peon", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await upsertSession("workspace", "peon", { id: "deleted-remotely", lastActivityAt: 10 });

  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sessions: [] }));
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  try {
    assert.equal(await reconcilePeon({
      peonId: "peon", credentialId: "credential", workspaceId: "workspace", name: "Peon",
      hostname: null, address: "127.0.0.1", controlPort: port, publicUrl: `http://127.0.0.1:${port}`,
      addressSource: "advertised", protocol: 1, capabilities: [], token: "token", connectionPinned: false,
      registeredAt: 1, lastSeen: 1, load: null,
    }), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual((await listSessions({ peonId: "peon", limit: 10, offset: 0 })).sessions, []);
  const events = await query<{ payload: { deleted?: boolean; sessionId?: string } }>(`SELECT payload FROM events WHERE session_id=$1`, ["deleted-remotely"]);
  assert.equal(events.rows.at(-1)?.payload.deleted, true);
  assert.equal(events.rows.at(-1)?.payload.sessionId, "deleted-remotely");
});
