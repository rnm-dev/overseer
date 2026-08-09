import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { allowedProjectKeys, canAccessPeon, canAccessProject, listMemberAccess, projectAccessQuery, projectMemberCounts, replaceMemberAccess } from "./index.js";
import { eventVisible, projectVisible, type AccessClient } from "./index.js";
import { backfillStoredSessionProjectIds, listSessions, resolveSessionProjectIds } from "../sessions/index.js";

test("legacy session keys receive a project ID only when the folded mapping is unambiguous", () => {
  const resolved = resolveSessionProjectIds([
    { projectKey: "expo", projectId: "project-expo" },
    { projectKey: "EXPO", projectId: null },
    { projectKey: "other", projectId: null },
  ]);
  assert.deepEqual(resolved.map((session) => session.projectId), ["project-expo", "project-expo", null]);

  const ambiguous = resolveSessionProjectIds([
    { projectKey: "expo", projectId: "one" },
    { projectKey: "EXPO", projectId: "two" },
    { projectKey: "ExPo", projectId: null },
  ]);
  assert.equal(ambiguous[2]?.projectId, null);
});

test("cached legacy sessions missing from Peon reconciliation receive the unique folded project ID", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO sessions (peon_id,session_id,project_key,raw,synced_at) VALUES ('p1','legacy','EXPO','{}',1)`);
  await backfillStoredSessionProjectIds("p1", [{ projectKey: "expo", projectId: "project-expo" }]);
  const { rows } = await query<{ project_id: string | null }>(`SELECT project_id FROM sessions WHERE peon_id='p1' AND session_id='legacy'`);
  assert.equal(rows[0]?.project_id, "project-expo");
});

test("regular members only access explicitly granted peons and projects while owners remain unrestricted", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('owner','owner@test',1),('member','member@test',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('ws','Workspace','workspace',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('ws','owner','owner',1),('ws','member','member',1)`);

  assert.equal(await canAccessPeon("ws", "member", "member", "p1"), false);
  assert.equal(await canAccessProject("ws", "member", "member", "p1", "secret"), false);
  await replaceMemberAccess("ws", "member", { peonIds: ["p1"], projects: [{ peonId: "p1", projectKey: "shared" }] }, "owner");

  assert.equal(await canAccessPeon("ws", "member", "member", "p1"), true);
  assert.equal(await canAccessPeon("ws", "member", "member", "p2"), false);
  assert.equal(await canAccessProject("ws", "member", "member", "p1", "shared"), true);
  assert.equal(await canAccessProject("ws", "member", "member", "p1", "secret"), false);
  assert.deepEqual(await allowedProjectKeys("ws", "member", "member", "p1"), ["shared"]);
  assert.deepEqual(await listMemberAccess("ws", "member"), { peonIds: ["p1"], projects: [{ peonId: "p1", projectKey: "shared", projectId: null }] });
  assert.equal(await canAccessPeon("ws", "owner", "owner", "anything"), true);
  assert.equal(await canAccessProject("ws", "owner", "owner", "anything", "anything"), true);
});

test("stable project IDs survive key changes and do not authorize key reuse", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await replaceMemberAccess("ws", "member", {
    peonIds: ["p1"],
    projects: [{ peonId: "p1", projectKey: "EXPO", projectId: "project-expo" }],
  }, "owner");

  assert.equal(await canAccessProject("ws", "member", "member", "p1", "expo", "project-expo"), true);
  assert.equal(await canAccessProject("ws", "member", "member", "p1", "EXPO", "different-project"), false);

  await replaceMemberAccess("ws", "legacy-member", {
    peonIds: ["p1"],
    projects: [{ peonId: "p1", projectKey: "EXPO", projectId: null }],
  }, "owner");
  assert.equal(await canAccessProject("ws", "legacy-member", "member", "p1", "EXPO"), true);
  assert.equal(await canAccessProject("ws", "legacy-member", "member", "p1", "EXPO", "reused-project"), false);
});

test("project access queries bind contiguous parameters for stable IDs and legacy keys", () => {
  const stable = projectAccessQuery("ws", "member", "p1", "renamed-key", "project-expo");
  assert.match(stable.text, /project_id = \$4/);
  assert.doesNotMatch(stable.text, /\$5/);
  assert.deepEqual(stable.values, ["ws", "member", "p1", "project-expo"]);

  const legacy = projectAccessQuery("ws", "member", "p1", "EXPO", null);
  assert.match(legacy.text, /project_id IS NULL AND project_key = \$4/);
  assert.deepEqual(legacy.values, ["ws", "member", "p1", "EXPO"]);
});

test("project member counts include every owner and only explicitly granted regular members", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES
    ('owner-1','owner1@test',1),('owner-2','owner2@test',1),('member-1','member1@test',1),('member-2','member2@test',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('ws','Workspace','workspace',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES
    ('ws','owner-1','owner',1),('ws','owner-2','owner',1),('ws','member-1','member',1),('ws','member-2','member',1)`);
  await replaceMemberAccess("ws", "member-1", {
    peonIds: ["p1"],
    projects: [{ peonId: "p1", projectKey: "renamed", projectId: "project-1" }],
  }, "owner-1");
  await replaceMemberAccess("ws", "member-2", {
    peonIds: ["p1"],
    projects: [{ peonId: "p1", projectKey: "legacy", projectId: null }],
  }, "owner-1");

  assert.deepEqual(await projectMemberCounts("ws", "p1", [
    { projectId: "project-1", key: "renamed" },
    { projectId: "project-2", key: "legacy" },
    { projectId: "project-3", key: "private" },
  ]), [3, 3, 2]);
});

test("live access treats a supplied project ID as authoritative", () => {
  const client: AccessClient = {
    userId: "member",
    workspaceId: "ws",
    role: "member",
    allowedPeons: new Set(["p1"]),
    allowedProjects: new Map([["p1", new Set(["key:EXPO"])]]),
    tails: new Map(),
  };
  assert.equal(projectVisible(client, "p1", "EXPO"), true);
  assert.equal(projectVisible(client, "p1", "EXPO", "reused-project"), false);
});

test("project catalog events are filtered by stable project ID, including tombstones", () => {
  const client: AccessClient = {
    userId: "member", workspaceId: "ws", role: "member",
    allowedPeons: new Set(["p1"]), allowedProjects: new Map([["p1", new Set(["id:visible"])]]), tails: new Map(),
  };
  assert.equal(eventVisible(client, {
    cursor: 1, workspaceId: "ws", peonId: "p1", sessionId: null, kind: "project",
    payload: { peonId: "p1", projectId: "visible", deleted: true, syncedAt: 1 }, createdAt: 1,
  }), true);
  assert.equal(eventVisible(client, {
    cursor: 2, workspaceId: "ws", peonId: "p1", sessionId: null, kind: "project",
    payload: { peonId: "p1", projectId: "hidden", key: "same-key", syncedAt: 2 }, createdAt: 2,
  }), false);
});

test("attention events are visible only to their target user", () => {
  const client: AccessClient = {
    userId: "member", workspaceId: "ws", role: "member",
    allowedPeons: new Set(["p1"]), allowedProjects: new Map(), tails: new Map(),
  };
  const event = {
    cursor: 3, workspaceId: "ws", peonId: "p1", sessionId: "s1", kind: "attention" as const,
    payload: { userId: "member", peonId: "p1", sessionId: "s1", unread: true }, createdAt: 3,
  };
  assert.equal(eventVisible(client, event), true);
  assert.equal(eventVisible(client, { ...event, payload: { ...event.payload, userId: "other" } }), false);
});

test("member ACLs are applied before session pagination and counting", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO peons (peon_id,credential_id,workspace_id,name,address,control_port,capabilities,token,registered_at,last_seen)
     VALUES ('visible','c1','ws','Visible','127.0.0.1',1,'[]','t',1,1),('hidden','c2','ws','Hidden','127.0.0.1',1,'[]','t',1,1)`,
  );
  await query(
    `INSERT INTO sessions (peon_id,session_id,project_key,project_id,last_activity_at,raw,synced_at) VALUES
      ('hidden','newest',NULL,NULL,300,'{}',300),
      ('visible','allowed-project','renamed-shared','project-shared',200,'{}',200),
      ('visible','unscoped',NULL,NULL,100,'{}',100),
      ('visible','forbidden-project','shared','different-project',50,'{}',50)`,
  );
  await replaceMemberAccess("ws", "member", {
    peonIds: ["visible"],
    projects: [{ peonId: "visible", projectKey: "shared", projectId: "project-shared" }],
  }, "owner");

  const first = await listSessions({ workspaceId: "ws", access: { userId: "member" }, limit: 1, offset: 0 });
  const second = await listSessions({ workspaceId: "ws", access: { userId: "member" }, limit: 1, offset: 1 });
  assert.equal(first.total, 2);
  assert.deepEqual(first.sessions.map((session) => session.sessionId), ["allowed-project"]);
  assert.deepEqual(second.sessions.map((session) => session.sessionId), ["unscoped"]);

  const capped = await listSessions({ workspaceId: "ws", access: { userId: "member" }, perPeonLimit: 1, limit: 200, offset: 0 });
  assert.equal(capped.total, 2);
  assert.deepEqual(capped.sessions.map((session) => session.sessionId), ["allowed-project"]);
});
