import { randomBytes, randomUUID } from "node:crypto";
import { transaction } from "../../infrastructure/db/index.js";
import { hashPassword, PasswordAuthError } from "./authPassword.js";

// A workspace owner or project administrator replaces a member's forgotten
// password from the members screen. The server picks the password, so nobody
// chooses one for somebody else, and it is answered once and never stored.
//
// Owners are out of reach — of this workspace or any other that holds someone
// else or a Peon, because the account is global and an owner elsewhere must
// not be taken over from here — and so is the caller themself. Only accounts that already sign in with a
// password qualify; giving a GitHub-only account one stays a shell operation.

export async function adminResetMemberPassword(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}): Promise<{ temporaryPassword: string; revokedDevices: number }> {
  if (input.actorUserId === input.targetUserId) {
    throw new PasswordAuthError(409, "CANNOT_RESET_SELF", "change your own password instead of resetting it");
  }
  // 15 random bytes → 20 base64url characters, comfortably over the minimum.
  const temporaryPassword = randomBytes(15).toString("base64url");
  const hash = await hashPassword(temporaryPassword);
  const revokedDevices = await transaction(async (tx) => {
    const { rows } = await tx.query<{ role: string; has_password: boolean }>(
      `SELECT m.role, (u.password_hash IS NOT NULL) AS has_password
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [input.workspaceId, input.targetUserId],
    );
    const target = rows[0];
    if (!target) throw new PasswordAuthError(404, "UNKNOWN_MEMBER", "not a member");
    if (!target.has_password) throw new PasswordAuthError(409, "NO_PASSWORD", "this account does not sign in with a password");
    // A personal workspace nobody else is in and no Peon is enrolled in does
    // not count: open sign-up gives every account one, and it guards nothing.
    const owner = await tx.query(
      `SELECT m.workspace_id FROM workspace_members m
         LEFT JOIN workspace_members o ON o.workspace_id = m.workspace_id AND o.user_id <> $1
         LEFT JOIN peons p ON p.workspace_id = m.workspace_id
        WHERE m.user_id = $1 AND m.role = 'owner' AND (o.user_id IS NOT NULL OR p.peon_id IS NOT NULL)
        LIMIT 1`,
      [input.targetUserId],
    );
    if (owner.rows.length > 0) throw new PasswordAuthError(409, "CANNOT_RESET_OWNER", "a workspace owner's password cannot be reset here");
    const now = Date.now();
    await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [input.targetUserId, hash]);
    const { rowCount } = await tx.query(`UPDATE devices SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [input.targetUserId, now]);
    const revoked = rowCount ?? 0;
    await tx.query(
      `INSERT INTO password_reset_audit (id, workspace_id, actor_user_id, target_user_id, revoked_devices, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), input.workspaceId, input.actorUserId, input.targetUserId, revoked, now],
    );
    return revoked;
  });
  return { temporaryPassword, revokedDevices };
}
