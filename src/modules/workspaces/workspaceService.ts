import { randomBytes, randomUUID } from "node:crypto";
import { query, transaction } from "../../db.js";
import type {
  AcceptResult,
  InviteRecord,
  MemberRecord,
  RemoveMemberResult,
  Role,
  UpdateRoleResult,
  WorkspaceWithRole,
} from "./workspaceTypes.js";

// Multi-tenant workspaces — the ACL layer. A workspace scopes its members (users)
// and its peons. Peons connect via overseer-minted credentials (credentials.ts).
// People join via shareable invite links (workspace_invitations), not email invites.

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  return findAvailableSlug(base);
}

async function findAvailableSlug(base: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await query(`SELECT 1 FROM workspaces WHERE slug = $1`, [slug]);
    if (rows.length === 0) return slug;
  }
  return `${base}-${randomUUID().slice(0, 6)}`;
}

// ---- workspaces + membership --------------------------------------------

export async function createWorkspace(name: string, ownerUserId: string): Promise<WorkspaceWithRole> {
  const id = randomUUID();
  const slug = await uniqueSlug(name);
  const now = Date.now();
  await transaction(async (tx) => {
    await tx.query(`INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`, [
      id, name, slug, ownerUserId, now,
    ]);
    await tx.query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, $2, 'owner', $3)`, [id, ownerUserId, now]);
  });
  return { id, name, slug, createdAt: now, role: "owner" };
}

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceWithRole[]> {
  const { rows } = await query<{ id: string; name: string; slug: string; created_at: number; role: Role }>(
    `SELECT w.id, w.name, w.slug, w.created_at, m.role
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = $1 ORDER BY w.created_at ASC`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, createdAt: r.created_at, role: r.role }));
}

// Membership check = the authorization gate for every workspace-scoped route.
export async function membership(workspaceId: string, userId: string): Promise<Role | null> {
  const { rows } = await query<{ role: Role }>(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
    workspaceId,
    userId,
  ]);
  return rows[0]?.role ?? null;
}

export async function listMembers(workspaceId: string): Promise<MemberRecord[]> {
  const { rows } = await query<{ user_id: string; email: string; github_login: string | null; avatar_url: string | null; role: Role; added_at: number }>(
    `SELECT m.user_id, u.email, u.github_login, u.avatar_url, m.role, m.added_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY m.added_at ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, githubLogin: r.github_login, avatarUrl: r.avatar_url, role: r.role, addedAt: r.added_at }));
}

export async function updateMemberRole(workspaceId: string, userId: string, role: Role): Promise<UpdateRoleResult> {
  return transaction(async (tx) => {
    // Every role change locks the same workspace row. Concurrent demotions can
    // no longer each observe the other owner and both commit.
    await tx.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId]);
    const { rows } = await tx.query<{ role: Role }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId],
    );
    const current = rows[0]?.role;
    if (!current) return "not_found";
    if (current === role) return "updated";
    if (current === "owner" && role === "member") {
      const owners = await tx.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [workspaceId],
      );
      if ((owners.rows[0]?.count ?? 0) <= 1) return "last_owner";
    }
    await tx.query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId, role]);
    return "updated";
  });
}

export async function removeMember(workspaceId: string, userId: string): Promise<RemoveMemberResult> {
  return transaction(async (tx) => {
    const current = await tx.query<{ role: Role }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE`, [workspaceId, userId],
    );
    const role = current.rows[0]?.role;
    if (!role) return "not_found";
    if (role === "owner") return "owner";
    await tx.query(`DELETE FROM workspace_member_project_access WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    await tx.query(`DELETE FROM workspace_member_peon_access WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    const { rowCount } = await tx.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'member'`, [workspaceId, userId]);
    return (rowCount ?? 0) > 0 ? "removed" : "not_found";
  });
}

// Every user gets a personal workspace on first sign-in so the app is never empty.
export async function ensureDefaultWorkspace(userId: string, email: string): Promise<void> {
  const { rows } = await query(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [userId]);
  if (rows.length > 0) return;
  const name = `${email.split("@")[0]}'s workspace`;
  await createWorkspace(name, userId);
}

// ---- invitations (shareable join links) ---------------------------------

// Short, URL-clean token (base62). 12 chars from 24 random bytes — plenty of entropy
// for a revocable, expiring link, without the 64-char eyesore of the old magic link.
function newInviteToken(): string {
  const bytes = randomBytes(24);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

interface InviteRow {
  id: string;
  workspace_id: string;
  token: string;
  invitee_label: string | null;
  role: Role;
  created_at: number;
  expires_at: number | null;
}
function rowToInvite(r: InviteRow): InviteRecord {
  return { id: r.id, workspaceId: r.workspace_id, token: r.token, inviteeLabel: r.invitee_label, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at };
}

// One link per pending member; accepting it consumes it permanently. The label
// is display-only and deliberately is not matched against the accepting user's
// GitHub email: possession of the private token is the invitation capability.
export async function createInvite(workspaceId: string, role: Role, createdBy: string, inviteeLabel: string): Promise<InviteRecord> {
  const id = randomUUID();
  const token = newInviteToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  await query(
    `INSERT INTO workspace_invitations (id, workspace_id, token, role, created_by, created_at, expires_at, revoked_at, invitee_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
    [id, workspaceId, token, role, createdBy, now, expiresAt, inviteeLabel],
  );
  return { id, workspaceId, token, inviteeLabel, role, createdAt: now, expiresAt };
}

export async function listInvites(workspaceId: string): Promise<InviteRecord[]> {
  const { rows } = await query<InviteRow>(
    `SELECT id, workspace_id, token, invitee_label, role, created_at, expires_at
       FROM workspace_invitations
      WHERE workspace_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
      ORDER BY created_at DESC`,
    [workspaceId, Date.now()],
  );
  return rows.map(rowToInvite);
}

export async function revokeInvite(workspaceId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE workspace_invitations SET revoked_at = $3 WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [id, workspaceId, Date.now()],
  );
  return (rowCount ?? 0) > 0;
}

// Public preview for the /join page: resolves a token to its workspace, or null if
// the link is unknown/revoked/expired.
export async function getInvitePreview(token: string): Promise<{ workspaceId: string; workspaceName: string; role: Role } | null> {
  const { rows } = await query<{ workspace_id: string; role: Role; name: string }>(
    `SELECT i.workspace_id, i.role, w.name
       FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.token = $1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > $2)`,
    [token, Date.now()],
  );
  const r = rows[0];
  return r ? { workspaceId: r.workspace_id, workspaceName: r.name, role: r.role } : null;
}

// Consume an invite for an authenticated user: idempotently add them as a member.
export async function acceptInvite(token: string, userId: string): Promise<AcceptResult> {
  return transaction(async (tx) => {
    const now = Date.now();
    const consumed = await tx.query<{ workspace_id: string; role: Role }>(
      `UPDATE workspace_invitations SET accepted_by = $2, accepted_at = $3
        WHERE token = $1 AND revoked_at IS NULL AND accepted_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
        RETURNING workspace_id, role`,
      [token, userId, now],
    );
    const invite = consumed.rows[0];
    if (!invite) return { ok: false };
    const member = await tx.query<{ role: Role }>(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [invite.workspace_id, userId],
    );
    const existing = member.rows[0]?.role ?? null;
    if (!existing) {
      await tx.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [invite.workspace_id, userId, invite.role, now],
      );
    }
    const { rows } = await tx.query<{ id: string; name: string; slug: string; created_at: number; role: Role }>(
      `SELECT w.id, w.name, w.slug, w.created_at, m.role
         FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        WHERE w.id = $1 AND m.user_id = $2`,
      [invite.workspace_id, userId],
    );
    const w = rows[0];
    if (!w) throw new Error("accepted invitation did not create workspace membership");
    return {
      ok: true,
      alreadyMember: !!existing,
      workspace: { id: w.id, name: w.name, slug: w.slug, createdAt: w.created_at, role: w.role },
    };
  });
}
