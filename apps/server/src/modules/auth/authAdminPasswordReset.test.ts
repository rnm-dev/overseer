import assert from "node:assert/strict";
import { before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "../../infrastructure/config/index.js";
import { initDb, query } from "../../infrastructure/db/index.js";
import { adminResetMemberPassword, createAccountWithPassword, issueDevice, verifyPassword } from "./index.js";

const NO_CLIENT = { ip: null, userAgent: null };
const WS = "ws-reset";

before(async () => {
  config.auth = { ...config.auth, openSignup: true };
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO workspaces (id, name, slug, created_at) VALUES ($1, 'Team', 'team', 0)`, [WS]);
});

async function account(email: string, role: "owner" | "member" | null): Promise<string> {
  const user = await createAccountWithPassword({ email, password: "old-password-1" });
  // Open sign-up made a personal workspace; drop it so roles are what the test says.
  await query(`DELETE FROM workspace_members WHERE user_id = $1`, [user.id]);
  if (role) await query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at, joined_via) VALUES ($1,$2,$3,0,'invitation')`, [WS, user.id, role]);
  return user.id;
}

async function hashOf(userId: string): Promise<string> {
  const { rows } = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return rows[0].password_hash;
}

test("sets a fresh temporary password, signs the member out and records who did it", async () => {
  const admin = await account("admin@example.com", "owner");
  const member = await account("member@example.com", "member");
  await issueDevice(member, "laptop", NO_CLIENT);

  const result = await adminResetMemberPassword({ workspaceId: WS, actorUserId: admin, targetUserId: member });

  assert.ok(result.temporaryPassword.length >= 20);
  assert.equal(result.revokedDevices, 1);
  assert.equal(await verifyPassword(result.temporaryPassword, await hashOf(member)), true);
  assert.equal(await verifyPassword("old-password-1", await hashOf(member)), false);
  const audit = await query<{ actor_user_id: string; target_user_id: string }>(`SELECT actor_user_id, target_user_id FROM password_reset_audit`);
  assert.deepEqual(audit.rows, [{ actor_user_id: admin, target_user_id: member }]);
});

test("refuses owners, oneself, outsiders and accounts without a password", async () => {
  const actor = await account("actor@example.com", "member");
  const owner = await account("owner2@example.com", "owner");
  const outsider = await account("outsider@example.com", null);
  const github = await account("github@example.com", "member");
  await query(`UPDATE users SET password_hash = NULL WHERE id = $1`, [github]);
  const before = await hashOf(owner);

  const attempt = (targetUserId: string) => adminResetMemberPassword({ workspaceId: WS, actorUserId: actor, targetUserId });
  await assert.rejects(attempt(owner), { code: "CANNOT_RESET_OWNER" });
  await assert.rejects(attempt(actor), { code: "CANNOT_RESET_SELF" });
  await assert.rejects(attempt(outsider), { code: "UNKNOWN_MEMBER" });
  await assert.rejects(attempt(github), { code: "NO_PASSWORD" });
  assert.equal(await hashOf(owner), before);
});

test("an owner of another shared workspace is out of reach too", async () => {
  const actor = await account("actor3@example.com", "owner");
  const target = await account("elsewhere@example.com", "member");
  const peer = await account("peer@example.com", null);
  await query(`INSERT INTO workspaces (id, name, slug, created_at) VALUES ('ws-other', 'Other', 'other', 0)`);
  await query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at, joined_via) VALUES ('ws-other',$1,'owner',0,'creator'), ('ws-other',$2,'member',0,'invitation')`, [target, peer]);
  await assert.rejects(adminResetMemberPassword({ workspaceId: WS, actorUserId: actor, targetUserId: target }), { code: "CANNOT_RESET_OWNER" });
});
