import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import {
  applySocketProjectEvent,
  applySocketProjectSnapshot,
  claimProjectSyncGeneration,
  commitSnapshotCoveredProjectEvent,
  hasCanonicalProjectCatalog,
  listIndexedProjects,
  releaseProjectSyncGeneration,
} from "./projectIndex.js";
import { claimSessionSyncGeneration } from "./sessionIndex.js";

async function fixture() {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('ws','Workspace','workspace',1)`);
  await query(
    `INSERT INTO peons (peon_id,credential_id,workspace_id,name,address,control_port,capabilities,token,registered_at,last_seen)
     VALUES ('peon','credential','ws','Peon','127.0.0.1',4570,'[]','token',1,1)`,
  );
  const generation = "generation";
  await claimSessionSyncGeneration("peon", generation);
  await claimProjectSyncGeneration("peon", generation);
  return { generation };
}

test("project snapshots replace the stable-ID projection and derive session rollups locally", async () => {
  const { generation } = await fixture();
  await query(
    `INSERT INTO sessions (peon_id,session_id,status,project_key,project_id,last_activity_at,raw,synced_at)
     VALUES ('peon','one','running','old-key','project-1',20,'{}',20),
            ('peon','two','completed','old-key','project-1',10,'{}',10),
            ('peon','legacy-reused','running','new-key',NULL,30,'{}',30)`,
  );

  await applySocketProjectSnapshot({
    workspaceId: "ws",
    peonId: "peon",
    generation,
    catalogEpoch: "projects-1",
    barrierSeq: 0,
    projects: [{ projectId: "project-1", key: "new-key", name: "Project", dir: "/work/project", metadata: "Notes" }],
  });

  assert.equal(await hasCanonicalProjectCatalog("peon"), true);
  const projects = await listIndexedProjects("peon");
  assert.equal(projects.length, 1);
  assert.deepEqual({
    projectId: projects[0]?.projectId,
    key: projects[0]?.key,
    sessionCount: projects[0]?.sessionCount,
    activeCount: projects[0]?.activeCount,
    lastActivityMs: projects[0]?.lastActivityMs,
  }, { projectId: "project-1", key: "new-key", sessionCount: 2, activeCount: 1, lastActivityMs: 20 });
});

test("project snapshots migrate unambiguous legacy grants and do not rebroadcast unchanged rows", async () => {
  const { generation } = await fixture();
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('ws','member','member',1)`,
  );
  await query(
    `INSERT INTO workspace_member_project_access (workspace_id,user_id,peon_id,project_key,granted_at,project_id)
     VALUES ('ws','member','peon','old-key',1,NULL)`,
  );
  const snapshot = {
    workspaceId: "ws", peonId: "peon", generation, catalogEpoch: "projects-1", barrierSeq: 0,
    projects: [{ projectId: "project-1", key: "old-key", name: "Project", dir: "/work/project", metadata: null }],
  };
  await applySocketProjectSnapshot(snapshot);

  const grant = await query<{ project_id: string | null }>(
    `SELECT project_id FROM workspace_member_project_access WHERE workspace_id='ws' AND user_id='member'`,
  );
  assert.equal(grant.rows[0]?.project_id, "project-1");
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM events WHERE kind='project'`)).rows[0]?.count, 1);

  await applySocketProjectSnapshot({ ...snapshot, catalogEpoch: "projects-2" });
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM events WHERE kind='project'`)).rows[0]?.count, 1);
});

test("project durable events share the delivery inbox, deduplicate replays, and preserve stable IDs across rename/delete", async () => {
  const { generation } = await fixture();
  await applySocketProjectSnapshot({
    workspaceId: "ws", peonId: "peon", generation, catalogEpoch: "projects-1", barrierSeq: 0,
    projects: [{ projectId: "project-1", key: "old", name: null, dir: null, metadata: null }],
  });
  const event = {
    workspaceId: "ws", peonId: "peon", generation,
    catalogEpoch: "projects-1", seq: 1,
    deliveryEpoch: "delivery-1", deliveryCursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000001",
    operation: "upsert" as const,
    project: { projectId: "project-1", key: "renamed", name: "Renamed", dir: "/renamed", metadata: null },
  };
  assert.equal((await applySocketProjectEvent(event)).delivery.acknowledgedCursor, "cursor-1");
  assert.equal((await applySocketProjectEvent(event)).delivery.acknowledgedCursor, "cursor-1");
  assert.equal((await listIndexedProjects("peon"))[0]?.key, "renamed");
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count, 1);

  await applySocketProjectEvent({
    workspaceId: "ws", peonId: "peon", generation,
    catalogEpoch: "projects-1", seq: 2,
    deliveryEpoch: "delivery-1", deliveryCursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000002",
    operation: "delete", projectId: "project-1",
  });
  assert.deepEqual(await listIndexedProjects("peon"), []);

  await releaseProjectSyncGeneration("peon", generation);
  const state = await query<{ status: string }>(`SELECT status FROM peon_project_sync WHERE peon_id='peon'`);
  assert.equal(state.rows[0]?.status, "stale");
});

test("project snapshot supersedes queued events from a retired catalog epoch", async () => {
  const { generation } = await fixture();
  await applySocketProjectSnapshot({
    workspaceId: "ws", peonId: "peon", generation, catalogEpoch: "projects-new", barrierSeq: 0,
    projects: [{ projectId: "project-current", key: "current", name: null, dir: null, metadata: null }],
  });

  const committed = await commitSnapshotCoveredProjectEvent({
    peonId: "peon", generation, catalogEpoch: "projects-retired", seq: 99,
    deliveryEpoch: "delivery-stable", deliveryCursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000099",
  });

  assert.deepEqual(committed, {
    catalog: { epoch: "projects-new", acknowledgedSeq: 0 },
    delivery: { epoch: "delivery-stable", acknowledgedCursor: "cursor-1" },
  });
  assert.deepEqual((await listIndexedProjects("peon")).map((project) => project.projectId), ["project-current"]);
  assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count, 1);
});
