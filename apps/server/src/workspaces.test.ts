import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./infrastructure/db/index.js";
import { acceptInvite, createInvite, createWorkspace, membership, removeMember, updateMemberRole } from "./workspaces.js";

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

test("member roles are editable without allowing the final owner to be demoted", async () => {
  const db = newDb();
  const pool = db.adapters.createPg().Pool;
  await initDb(new pool());
  await query(`INSERT INTO users (id, email, created_at) VALUES ('owner-1', 'owner@example.test', $1), ('member-1', 'member@example.test', $1)`, [Date.now()]);
  const workspace = await createWorkspace("Roles", "owner-1");
  await query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, 'member-1', 'member', $2)`, [workspace.id, Date.now()]);

  assert.equal(await updateMemberRole(workspace.id, "owner-1", "member"), "last_owner");
  assert.equal(await updateMemberRole(workspace.id, "member-1", "owner"), "updated");
  assert.equal(await updateMemberRole(workspace.id, "owner-1", "member"), "updated");
  assert.equal(await membership(workspace.id, "owner-1"), "member");
  assert.equal(await membership(workspace.id, "member-1"), "owner");
});

test("an individual invitation is single-use and does not match its label to GitHub email", async () => {
  const db = newDb();
  const pool = db.adapters.createPg().Pool;
  await initDb(new pool());
  await query(`INSERT INTO users (id, email, created_at) VALUES ('owner-1', 'owner@example.test', $1), ('member-1', 'member@example.test', $1), ('member-2', 'other@example.test', $1)`, [Date.now()]);
  const workspace = await createWorkspace("Invites", "owner-1");
  const invite = await createInvite(workspace.id, "member", "owner-1", "Sam");

  assert.equal(invite.inviteeLabel, "Sam");
  assert.equal((await acceptInvite(invite.token, "member-1")).ok, true);
  assert.deepEqual(await acceptInvite(invite.token, "member-2"), { ok: false });
  assert.equal(await membership(workspace.id, "member-1"), "member");
  assert.equal(await membership(workspace.id, "member-2"), null);
});
