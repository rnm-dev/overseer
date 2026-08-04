import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./infrastructure/db/index.js";
import {
  applySocketProjectEvent,
  applySocketProjectSnapshot,
  claimProjectSyncGeneration,
  commitSnapshotCoveredProjectEvent,
  forgetIndexedProject,
  hasCanonicalProjectCatalog,
  listIndexedProjects,
  normalizeProjectQuickLinks,
  refreshIndexedProjectQuickLinks,
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
    projects: [{
      projectId: "project-1",
      key: "new-key",
      name: "Project",
      dir: "/work/project",
      metadata: "Notes",
      quickLinks: [{ id: "docs", title: "Docs", url: "https://example.test/docs", order: 2 }],
    }],
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
  assert.deepEqual(projects[0]?.quickLinks, [{ id: "docs", title: "Docs", url: "https://example.test/docs", order: 2 }]);
});

test("quick-link cache refresh uses Peon data, publishes the projection, and rejects unsafe URLs", async () => {
  const { generation } = await fixture();
  await applySocketProjectSnapshot({
    workspaceId: "ws", peonId: "peon", generation, catalogEpoch: "projects-1", barrierSeq: 0,
    projects: [{ projectId: "project-1", key: "project", name: "Project", dir: "/work/project", metadata: null }],
  });

  assert.equal(await refreshIndexedProjectQuickLinks({
    workspaceId: "ws",
    peonId: "peon",
    key: "project",
    quickLinks: [
      { id: "runbook", title: "Runbook", url: "https://example.test/runbook", order: 3 },
      { id: "home", title: "Home", url: "https://example.test/", order: 1 },
    ],
  }), true);
  assert.deepEqual((await listIndexedProjects("peon"))[0]?.quickLinks?.map((link) => link.id), ["home", "runbook"]);
  await assert.rejects(
    () => refreshIndexedProjectQuickLinks({
      workspaceId: "ws",
      peonId: "peon",
      key: "project",
      quickLinks: [{ id: "bad", title: "Bad", url: "javascript:alert(1)", order: 0 }],
    }),
    /invalid project quick link URL/,
  );
  assert.deepEqual(normalizeProjectQuickLinks(undefined), []);
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

test("forgetting a deleted project evicts the projection, drops its grants, and leaves the catalog event idempotent", async () => {
  const { generation } = await fixture();
  await applySocketProjectSnapshot({
    workspaceId: "ws", peonId: "peon", generation, catalogEpoch: "projects-1", barrierSeq: 0,
    projects: [
      { projectId: "project-1", key: "doomed", name: "Doomed", dir: "/work/doomed", metadata: null },
      { projectId: "project-2", key: "kept", name: "Kept", dir: "/work/kept", metadata: null },
    ],
  });
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('ws','member','member',1)`);
  await query(
    `INSERT INTO workspace_member_project_access (workspace_id,user_id,peon_id,project_key,granted_at,project_id)
     VALUES ('ws','member','peon','doomed',1,'project-1'),
            ('ws','member','peon','kept',1,'project-2')`,
  );

  await forgetIndexedProject({ workspaceId: "ws", peonId: "peon", key: "doomed" });

  assert.deepEqual((await listIndexedProjects("peon")).map((project) => project.projectId), ["project-2"]);
  const grants = await query<{ project_id: string | null }>(
    `SELECT project_id FROM workspace_member_project_access WHERE workspace_id='ws' AND peon_id='peon'`,
  );
  assert.deepEqual(grants.rows.map((row) => row.project_id), ["project-2"]);
  const deletion = await query<{ payload: unknown }>(`SELECT payload FROM events WHERE kind='project' ORDER BY cursor DESC LIMIT 1`);
  const raw = deletion.rows[0]?.payload;
  const payload = (typeof raw === "string" ? JSON.parse(raw) : raw) as { projectId?: string; deleted?: boolean };
  assert.deepEqual({ projectId: payload.projectId, deleted: payload.deleted }, { projectId: "project-1", deleted: true });

  // The Peon's own catalog event lands afterwards and must still advance.
  const checkpoint = await applySocketProjectEvent({
    workspaceId: "ws", peonId: "peon", generation,
    catalogEpoch: "projects-1", seq: 1,
    deliveryEpoch: "delivery-1", deliveryCursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000011",
    operation: "delete", projectId: "project-1",
  });
  assert.equal(checkpoint.catalog?.acknowledgedSeq, 1);
  assert.deepEqual((await listIndexedProjects("peon")).map((project) => project.projectId), ["project-2"]);
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
