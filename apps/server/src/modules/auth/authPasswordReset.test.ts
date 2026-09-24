import assert from "node:assert/strict";
import { before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "../../infrastructure/config/index.js";
import { initDb, query } from "../../infrastructure/db/index.js";
import { createAccountWithPassword, issueDevice, resetPasswordByEmail, verifyPassword } from "./index.js";

const NO_CLIENT = { ip: null, userAgent: null };

before(async () => {
  config.auth = { ...config.auth, openSignup: true };
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
});

async function hashOf(userId: string): Promise<string> {
  const { rows } = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return rows[0].password_hash;
}

test("replaces the password and signs out every device of that account only", async () => {
  const user = await createAccountWithPassword({ email: "forgot@example.com", password: "old-password-1" });
  const other = await createAccountWithPassword({ email: "bystander@example.com", password: "other-password-1" });
  await issueDevice(user.id, "laptop", NO_CLIENT);
  await issueDevice(user.id, "phone", NO_CLIENT);
  await issueDevice(other.id, "laptop", NO_CLIENT);

  const result = await resetPasswordByEmail({ email: "Forgot@Example.com", password: "new-password-1" });

  assert.equal(result.user.id, user.id);
  assert.equal(result.revokedDevices, 2);
  assert.equal(await verifyPassword("new-password-1", await hashOf(user.id)), true);
  assert.equal(await verifyPassword("old-password-1", await hashOf(user.id)), false);
  const { rows } = await query<{ user_id: string }>(`SELECT user_id FROM devices WHERE revoked_at IS NULL`);
  assert.deepEqual(rows.map((r) => r.user_id), [other.id]);
});

test("refuses an unknown address and a weak password without touching anything", async () => {
  await assert.rejects(resetPasswordByEmail({ email: "nobody@example.com", password: "new-password-1" }), { code: "UNKNOWN_ACCOUNT" });
  await assert.rejects(resetPasswordByEmail({ email: "bystander@example.com", password: "short" }), { code: "WEAK_PASSWORD" });
  await assert.rejects(resetPasswordByEmail({ email: "not-an-email", password: "new-password-1" }), { code: "INVALID_EMAIL" });
});
