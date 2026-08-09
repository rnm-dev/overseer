import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { issueDevice } from "../auth/index.js";
import { initDb, query, setPool } from "../../infrastructure/db/index.js";
import { replaceMemberAccess } from "../access/index.js";
import { registry } from "../fleet/index.js";
import { createServer } from "../../app/server.js";
import { createWorkspace } from "../workspaces/index.js";
import { recordSessionRequest } from "./index.js";

const servers: http.Server[] = [];
after(async () => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

interface RecentSession {
  peonId: string;
  sessionId: string;
  status: string | null;
  title: string | null;
  promptPreview: string | null;
  preview: string | null;
  projectId: string | null;
  projectKey: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  syncedAt: number;
  lastRequestedAt: number | null;
  hasOutstandingRequest: boolean;
  attentionUnread: boolean;
  attentionUpdatedAt: number;
}

interface PeonPayload {
  peonId: string;
  recentSessions?: RecentSession[];
}

async function setup(): Promise<{ port: number; workspaceId: string; ownerToken: string; memberToken: string; queries: () => number }> {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  const pool = new Pool() as unknown as pg.Pool;
  await initDb(pool);
  await query(
    `INSERT INTO users (id, email, created_at) VALUES ('owner', 'owner@example.test', $1), ('member', 'member@example.test', $1)`,
    [Date.now()],
  );
  const workspace = await createWorkspace("Fleet", "owner");
  await query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, 'member', 'member', $2)`, [workspace.id, Date.now()]);
  const owner = await issueDevice("owner", "test", { ip: null, userAgent: null });
  const member = await issueDevice("member", "test", { ip: null, userAgent: null });
  for (const peonId of ["p1", "p2"]) {
    await registry.register({
      peonId, credentialId: `cred-${peonId}`, workspaceId: workspace.id, name: peonId,
      hostname: null, address: "127.0.0.1", controlPort: 4570, protocol: 1, capabilities: [], token: `token-${peonId}`, load: null,
    });
  }
  // Counting wrapper installed after the fixture so only request traffic counts.
  let count = 0;
  const inner = pool.query.bind(pool) as pg.Pool["query"];
  (pool as { query: unknown }).query = (...args: unknown[]) => {
    count += 1;
    return (inner as (...a: unknown[]) => unknown)(...args);
  };
  setPool(pool);
  return {
    port: await listen(http.createServer(createServer())),
    workspaceId: workspace.id,
    ownerToken: owner.token,
    memberToken: member.token,
    queries: () => count,
  };
}

async function indexSession(input: {
  peonId: string;
  sessionId: string;
  title?: string | null;
  promptPreview?: string | null;
  preview?: string | null;
  projectKey?: string | null;
  projectId?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  syncedAt?: number;
}): Promise<void> {
  await query(
    `INSERT INTO sessions (peon_id, session_id, status, project_key, project_id, title, prompt_preview, preview, author, started_at, last_activity_at, raw, synced_at)
     VALUES ($1,$2,'running',$3,$4,$5,$6,$7,'someone@example.test',$8,$9,'{}',$10)`,
    [
      input.peonId, input.sessionId, input.projectKey ?? null, input.projectId ?? null,
      input.title ?? null, input.promptPreview ?? null, input.preview ?? null,
      input.startedAt ?? null, input.lastActivityAt ?? null, input.syncedAt ?? 1,
    ],
  );
}

function getJson(port: number, path: string, token: string): Promise<{ status: number; json: { peons: PeonPayload[] } }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) as { peons: PeonPayload[] } }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the fleet response carries the operator's own sessions with the fields Mobile renders", async () => {
  const app = await setup();
  await indexSession({
    peonId: "p1", sessionId: "titled", title: "Ship the fleet projection", promptPreview: "Ship it", preview: "Shipped",
    projectKey: "overseer", projectId: "project-1", startedAt: 5, lastActivityAt: 30, syncedAt: 91,
  });
  await indexSession({ peonId: "p1", sessionId: "untitled-but-prompted", promptPreview: "Investigate the flaky reconcile", lastActivityAt: 20 });
  await indexSession({ peonId: "p2", sessionId: "elsewhere", title: "Other box", lastActivityAt: 40 });
  await indexSession({ peonId: "p1", sessionId: "somebody-elses", title: "Not mine", lastActivityAt: 50 });
  for (const [index, session] of [["p1", "titled"], ["p1", "untitled-but-prompted"], ["p2", "elsewhere"]].entries()) {
    await recordSessionRequest({ workspaceId: app.workspaceId, userId: "owner", peonId: session[0], sessionId: session[1], occurrenceKey: `create:${index}`, requestedAt: 10 + index });
  }
  await recordSessionRequest({ workspaceId: app.workspaceId, userId: "member", peonId: "p1", sessionId: "somebody-elses", occurrenceKey: "create:9", requestedAt: 9 });

  const { status, json } = await getJson(app.port, `/api/workspaces/${app.workspaceId}/peons?includeRecentSessions=mine&recentSessionsLimit=10`, app.ownerToken);
  assert.equal(status, 200);
  const byPeon = new Map(json.peons.map((peon) => [peon.peonId, peon.recentSessions ?? []]));
  assert.deepEqual(byPeon.get("p1")?.map((session) => session.sessionId), ["titled", "untitled-but-prompted"]);
  assert.deepEqual(byPeon.get("p2")?.map((session) => session.sessionId), ["elsewhere"]);

  const titled = byPeon.get("p1")?.[0];
  assert.deepEqual(titled, {
    peonId: "p1",
    sessionId: "titled",
    status: "running",
    title: "Ship the fleet projection",
    promptPreview: "Ship it",
    preview: "Shipped",
    projectId: "project-1",
    projectKey: "overseer",
    startedAt: 5,
    lastActivityAt: 30,
    syncedAt: 91,
    lastRequestedAt: 10,
    hasOutstandingRequest: true,
    attentionUnread: false,
    attentionUpdatedAt: 10,
  });
  // The regression itself: an untitled session still arrives with something to
  // render, so the client never has to fall back to "Untitled session".
  const prompted = byPeon.get("p1")?.[1];
  assert.equal(prompted?.title, null);
  assert.equal(prompted?.promptPreview, "Investigate the flaky reconcile");
});

test("the projection is opt-in — without the query the payload and the work are unchanged", async () => {
  const app = await setup();
  await indexSession({ peonId: "p1", sessionId: "s1", title: "Something", lastActivityAt: 10 });
  await recordSessionRequest({ workspaceId: app.workspaceId, userId: "owner", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 5 });

  const before = app.queries();
  const plain = await getJson(app.port, `/api/workspaces/${app.workspaceId}/peons`, app.ownerToken);
  const plainQueries = app.queries() - before;
  assert.equal(plain.status, 200);
  assert.ok(plain.json.peons.every((peon) => !("recentSessions" in peon)));

  const withProjection = app.queries();
  await getJson(app.port, `/api/workspaces/${app.workspaceId}/peons?includeRecentSessions=mine`, app.ownerToken);
  const projectionQueries = app.queries() - withProjection;
  assert.equal(projectionQueries, plainQueries + 1, "the projection costs exactly one extra query for the whole fleet");
});

test("the per-Peon limit is applied and an excessive one is clamped", async () => {
  const app = await setup();
  for (const [index, peonId] of ["p1", "p1", "p1", "p2"].entries()) {
    await indexSession({ peonId, sessionId: `s${index}`, title: `Session ${index}`, lastActivityAt: 100 - index });
    await recordSessionRequest({ workspaceId: app.workspaceId, userId: "owner", peonId, sessionId: `s${index}`, occurrenceKey: `create:${index}`, requestedAt: index });
  }

  const bounded = await getJson(app.port, `/api/workspaces/${app.workspaceId}/peons?includeRecentSessions=mine&recentSessionsLimit=2`, app.ownerToken);
  const boundedByPeon = new Map(bounded.json.peons.map((peon) => [peon.peonId, peon.recentSessions ?? []]));
  assert.deepEqual(boundedByPeon.get("p1")?.map((session) => session.sessionId), ["s0", "s1"]);
  assert.deepEqual(boundedByPeon.get("p2")?.map((session) => session.sessionId), ["s3"]);

  for (const limit of ["9999", "-3", "banana"]) {
    const result = await getJson(app.port, `/api/workspaces/${app.workspaceId}/peons?includeRecentSessions=mine&recentSessionsLimit=${limit}`, app.ownerToken);
    assert.equal(result.status, 200, `limit=${limit} is answered, not rejected`);
    for (const peon of result.json.peons) assert.ok((peon.recentSessions ?? []).length <= 10, `limit=${limit} stays inside the documented bound`);
  }
});

test("a member's projection never crosses Peon or project access", async () => {
  const app = await setup();
  await indexSession({ peonId: "p1", sessionId: "shared", projectKey: "shared", title: "Shared", lastActivityAt: 20 });
  await indexSession({ peonId: "p1", sessionId: "secret", projectKey: "secret", title: "Secret", lastActivityAt: 30 });
  await indexSession({ peonId: "p2", sessionId: "ungranted", projectKey: "shared", title: "Ungranted", lastActivityAt: 40 });
  for (const [index, session] of [["p1", "shared"], ["p1", "secret"], ["p2", "ungranted"]].entries()) {
    await recordSessionRequest({ workspaceId: app.workspaceId, userId: "member", peonId: session[0], sessionId: session[1], occurrenceKey: `create:${index}`, requestedAt: index });
  }
  await replaceMemberAccess(app.workspaceId, "member", { peonIds: ["p1"], projects: [{ peonId: "p1", projectKey: "shared" }] }, "owner");

  const { json } = await getJson(app.port, `/api/workspaces/${app.workspaceId}/peons?includeRecentSessions=mine`, app.memberToken);
  assert.deepEqual(json.peons.map((peon) => peon.peonId), ["p1"], "an ungranted Peon is not in the fleet at all");
  assert.deepEqual(json.peons[0].recentSessions?.map((session) => session.sessionId), ["shared"]);
});
