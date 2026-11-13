import assert from "node:assert/strict";
import { before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { viewerMayDecide, type PeonSignoffSummary, type Viewer } from "./signoffService.js";

// Who may decide a sign-off (docs/signoffs.md): the named assignees, otherwise
// the project's administrators and the workspace owners.

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO workspace_project_administrators (workspace_id,user_id,peon_id,project_key,project_id,granted_at)
               VALUES ('w1','admin','p1','HB','proj-hb',1)`);
  await query(`INSERT INTO projects (peon_id,project_id,project_key,synced_at) VALUES ('p1','proj-hb','HB',1)`);
});

const summary = (over: Partial<PeonSignoffSummary> = {}): PeonSignoffSummary => ({
  id: "s1", projectKey: "HB", number: 1, displayNumber: "SO-1", title: "t", sessionId: "sess",
  headSeq: 1, status: "pending", assigneeIds: [], orphaned: false, createdAt: 1, updatedAt: 1, ...over,
});
const viewer = (userId: string, role: Viewer["role"], email = `${userId}@example.test`): Viewer =>
  ({ workspaceId: "w1", userId, email, role });

test("nobody named: owners and the project's administrators decide, members do not", async () => {
  assert.equal(await viewerMayDecide(viewer("o", "owner"), "p1", summary()), true);
  assert.equal(await viewerMayDecide(viewer("admin", "member"), "p1", summary()), true);
  assert.equal(await viewerMayDecide(viewer("m", "member"), "p1", summary()), false);
  assert.equal(await viewerMayDecide(viewer("admin", "member"), "p1", summary({ projectKey: "OTHER" })), false);
});

test("outside a project only owners decide", async () => {
  assert.equal(await viewerMayDecide(viewer("admin", "member"), "p1", summary({ projectKey: null })), false);
  assert.equal(await viewerMayDecide(viewer("o", "owner"), "p1", summary({ projectKey: null })), true);
});

test("named assignees decide, by email or user id, case-insensitively", async () => {
  const named = summary({ assigneeIds: ["M@Example.test"] });
  assert.equal(await viewerMayDecide(viewer("m", "member"), "p1", named), true);
  assert.equal(await viewerMayDecide(viewer("admin", "member"), "p1", named), false);
  assert.equal(await viewerMayDecide(viewer("m", "member"), "p1", summary({ assigneeIds: ["m"] })), true);
});

test("an orphaned sign-off cannot be decided by anyone", async () => {
  assert.equal(await viewerMayDecide(viewer("o", "owner"), "p1", summary({ orphaned: true })), false);
});
