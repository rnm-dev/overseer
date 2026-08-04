import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import { indexAcceptedSession } from "./modules/sessions/index.js";
import {
  applySocketSessionEvent,
  applySocketSessionSnapshot,
  claimSessionSyncGeneration,
  deleteIndexedSession,
  listSessions,
  reconcilePeon,
  releaseSessionSyncGeneration,
  StaleSessionSyncGenerationError,
  upsertSession,
} from "./sessionIndex.js";

test("session events carry exact affected project totals", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await upsertSession("workspace", "peon", { id: "one", projectId: "project", projectKey: "project", lastActivityAt: 1 });
  await upsertSession("workspace", "peon", { id: "two", projectId: "project", projectKey: "project", lastActivityAt: 2 });
  assert.equal(await deleteIndexedSession("workspace", "peon", "one"), true);

  const events = await query<{ payload: { projectSessionCounts?: Array<{ projectId: string | null; projectKey: string; sessionCount: number }> } }>(
    `SELECT payload FROM events WHERE session_id IN ('one','two') ORDER BY cursor`,
  );
  assert.deepEqual(events.rows.map((event) => event.payload.projectSessionCounts), [
    [{ projectId: "project", projectKey: "project", sessionCount: 1 }],
    [{ projectId: "project", projectKey: "project", sessionCount: 2 }],
    [{ projectId: "project", projectKey: "project", sessionCount: 1 }],
  ]);
});

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

test("session normalization never splits emoji or writes unpaired surrogates to JSONB", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await upsertSession("workspace", "peon", {
    id: "unicode",
    prompt: `${"x".repeat(199)}😀tail`,
    title: "broken-high-\ud83d",
    lastMessagePreview: "broken-low-\udc00",
    outcome: { message: "nested-\ud83d", "key-\udc00": ["valid-😀", "broken-\udc00"] },
  });

  const stored = await query<{ raw: Record<string, unknown>; outcome: Record<string, unknown> }>(
    `SELECT raw,outcome FROM sessions WHERE peon_id=$1 AND session_id=$2`,
    ["peon", "unicode"],
  );
  assert.equal(stored.rows[0]?.raw.promptPreview, `${"x".repeat(199)}😀`);
  assert.equal(stored.rows[0]?.raw.title, "broken-high-�");
  assert.equal(stored.rows[0]?.raw.lastMessagePreview, "broken-low-�");
  assert.deepEqual(stored.rows[0]?.outcome, {
    message: "nested-�",
    "key-�": ["valid-😀", "broken-�"],
  });
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

test("grouped session hydration returns the newest bounded slice of every project", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  const rows = [
    ["a-new", "project-a", 80], ["b-new", "project-b", 70],
    ["a-middle", "project-a", 60], ["b-middle", "project-b", 50],
    ["a-old", "project-a", 40], ["none-new", null, 30],
    ["b-old", "project-b", 20], ["none-old", null, 10],
  ] as const;
  for (const [id, projectId, activity] of rows) {
    await upsertSession("workspace", "peon", {
      id,
      projectId,
      projectKey: projectId,
      lastActivityAt: activity,
    });
  }

  const result = await listSessions({ peonId: "peon", perProjectLimit: 2, limit: 50, offset: 0 });
  assert.equal(result.total, 8);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), [
    "a-new", "b-new", "a-middle", "b-middle", "none-new", "none-old",
  ]);
});

test("a project-scoped query reaches sessions older than any sidebar page", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await upsertSession("workspace", "peon", { id: "other-new", projectKey: "project-b", lastActivityAt: 90 });
  for (let index = 0; index < 30; index += 1) {
    await upsertSession("workspace", "peon", { id: `noise-${index}`, projectKey: "project-b", lastActivityAt: 50 + index });
  }
  await upsertSession("workspace", "peon", { id: "a-old", projectKey: "project-a", lastActivityAt: 10 });
  await upsertSession("workspace", "peon", { id: "a-older", projectKey: "project-a", lastActivityAt: 5 });

  const result = await listSessions({ peonId: "peon", projectKey: "project-a", limit: 8, offset: 0 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.sessions.map((session) => session.sessionId), ["a-old", "a-older"]);
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

test("re-reading a session heals a run left running by a Peon that died mid-work", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  // The Peon died while working, so the last thing it ever said was "running".
  await upsertSession("workspace", "peon", { id: "orphan", status: "running", startedAt: 10, lastActivityAt: 20 });

  // Opening the session re-reads the record the restarted Peon rebuilt on boot.
  const read = {
    ok: true,
    json: {
      id: "orphan",
      status: "completed",
      startedAt: 10,
      lastActivityAt: 20,
      endedAt: 30,
      outcome: { result: "failure", summary: "Daemon restarted while this session was running." },
    },
  };
  assert.equal(await indexAcceptedSession(read, "workspace", "peon"), true);
  assert.equal((await listSessions({ peonId: "peon", limit: 10, offset: 0 })).sessions[0]?.status, "completed");

  // The same read repeats on every open and on each run-watchdog poll, so it
  // must stay silent once the index already agrees with the Peon.
  assert.equal(await indexAcceptedSession(read, "workspace", "peon"), true);
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM events WHERE session_id='orphan'`)).rows[0]?.count, 2);
});

test("reverse-connected session catalogs never race legacy HTTP reconciliation", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await upsertSession("workspace", "peon", { id: "last-known", lastActivityAt: 10 });

  const result = await reconcilePeon({
    peonId: "peon", credentialId: "credential", workspaceId: "workspace", name: "Peon",
    hostname: null, address: "unreachable.invalid", controlPort: 4570, publicUrl: null,
    addressSource: "discovered", protocol: 1, capabilities: ["session-catalog-v1"], token: "token",
    connectionPinned: false, registeredAt: 1, lastSeen: 1, load: null,
  });

  assert.equal(result, null);
  assert.deepEqual(
    (await listSessions({ peonId: "peon", limit: 10, offset: 0 })).sessions.map((session) => session.sessionId),
    ["last-known"],
  );
});

test("socket session commits are generation-fenced and durably deduplicated", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);

  await claimSessionSyncGeneration("fenced-peon", "old-generation");
  await claimSessionSyncGeneration("fenced-peon", "new-generation");
  await assert.rejects(
    applySocketSessionEvent({
      workspaceId: "workspace", peonId: "fenced-peon", generation: "old-generation",
      catalogEpoch: "catalog", seq: 1, deliveryEpoch: "delivery", deliveryCursor: "cursor-1",
      messageId: "00000000-0000-4000-8000-000000000001",
      operation: "upsert", session: { id: "stale-write", lastActivityAt: 1 },
    }),
    StaleSessionSyncGenerationError,
  );
  assert.deepEqual((await listSessions({ peonId: "fenced-peon", limit: 10, offset: 0 })).sessions, []);
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count, 0);

  await applySocketSessionSnapshot({
    workspaceId: "workspace", peonId: "fenced-peon", generation: "new-generation",
    catalogEpoch: "catalog", barrierSeq: 0, deliveryEpoch: "delivery", acknowledgedCursor: null, sessions: [],
  });
  const input = {
    workspaceId: "workspace", peonId: "fenced-peon", generation: "new-generation",
    catalogEpoch: "catalog", seq: 1, deliveryEpoch: "delivery", deliveryCursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000002", operation: "upsert" as const,
    session: { id: "committed-once", lastActivityAt: 2 },
  };
  const committed = {
    catalog: { epoch: "catalog", acknowledgedSeq: 1 },
    delivery: { epoch: "delivery", acknowledgedCursor: "cursor-1" },
  };
  assert.deepEqual(await applySocketSessionEvent(input), committed);
  assert.deepEqual(await applySocketSessionEvent(input), committed);
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count, 1);
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM events WHERE session_id='committed-once'`)).rows[0]?.count, 1);
});

test("legacy reconciliation remains available until the first socket snapshot succeeds", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sessions: [{ id: "legacy", lastActivityAt: requests }] }));
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  const record = {
    peonId: "cutover-peon", credentialId: "credential", workspaceId: "workspace", name: "Peon",
    hostname: null, address: "127.0.0.1", controlPort: port, publicUrl: `http://127.0.0.1:${port}`,
    addressSource: "advertised" as const, protocol: 1, capabilities: ["sessions"], token: "token",
    connectionPinned: false, registeredAt: 1, lastSeen: 1, load: null,
  };
  try {
    assert.equal(await reconcilePeon(record), 1);
    assert.equal(requests, 1, "HTTP registration metadata alone must not disable legacy sync");

    await query(
      `INSERT INTO peon_session_sync (peon_id, epoch, cursor, status, updated_at, generation)
       VALUES ($1,'retired-epoch','retired-cursor','ready',$2,NULL)`,
      [record.peonId, Date.now()],
    );
    assert.equal(await reconcilePeon(record), 1);
    assert.equal(requests, 2, "a pre-018 ready row must not count as canonical cutover");
    await query(`DELETE FROM peon_session_sync WHERE peon_id=$1`, [record.peonId]);

    await claimSessionSyncGeneration(record.peonId, "failed-first-sync");
    assert.equal(await reconcilePeon(record), null);
    assert.equal(requests, 2, "legacy sync must not race an active socket snapshot");
    await query(`UPDATE peon_session_sync SET updated_at=$2 WHERE peon_id=$1`, [record.peonId, Date.now() - 121_000]);
    assert.equal(await reconcilePeon(record), 1);
    assert.equal(requests, 3, "an abandoned first-sync lease must restore legacy fallback after a process crash");
    await releaseSessionSyncGeneration(record.peonId, "failed-first-sync");
    assert.equal(await reconcilePeon(record), 1);
    assert.equal(requests, 4, "a failed first socket sync restores legacy fallback");

    await claimSessionSyncGeneration(record.peonId, "successful-sync");
    await applySocketSessionSnapshot({
      workspaceId: record.workspaceId, peonId: record.peonId, generation: "successful-sync",
      catalogEpoch: "epoch", barrierSeq: 0, deliveryEpoch: "delivery", acknowledgedCursor: null,
      sessions: [{ id: "socket", lastActivityAt: 10 }],
    });
    await releaseSessionSyncGeneration(record.peonId, "successful-sync");
    assert.equal(await reconcilePeon(record), null);
    assert.equal(requests, 4, "successful socket cutover retains last-known rows without dual authority");

    await claimSessionSyncGeneration(record.peonId, "quiet-resume");
    await query(`UPDATE peon_session_sync SET updated_at=$2 WHERE peon_id=$1`, [record.peonId, Date.now() - 121_000]);
    assert.equal((await query<{ status: string }>(
      `SELECT status FROM peon_session_sync WHERE peon_id=$1`, [record.peonId],
    )).rows[0]?.status, "ready");
    assert.equal(await reconcilePeon(record), null);
    assert.equal(requests, 4, "a quiet canonical resume must never restore HTTP authority");
    await releaseSessionSyncGeneration(record.peonId, "quiet-resume");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
