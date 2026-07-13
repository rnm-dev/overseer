import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import { createWorkspace, membership, removeMember } from "./workspaces.js";

test("regular workspace members can be removed while owners stay protected", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3), ($4, $5, $6)`, [
    "owner-1", "owner@example.test", Date.now(),
    "member-1", "member@example.test", Date.now(),
  ]);
  const workspace = await createWorkspace("Removal", "owner-1");
  await query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, $2, 'member', $3)`, [workspace.id, "member-1", Date.now()]);

  assert.equal(await removeMember(workspace.id, "owner-1"), "owner");
  assert.equal(await membership(workspace.id, "owner-1"), "owner");
  assert.equal(await removeMember(workspace.id, "member-1"), "removed");
  assert.equal(await membership(workspace.id, "member-1"), null);
  assert.equal(await removeMember(workspace.id, "member-1"), "not_found");
});
