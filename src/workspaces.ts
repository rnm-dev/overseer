import { randomBytes, randomUUID } from "node:crypto";
import { query } from "./db.js";

// Multi-tenant workspaces — the ACL layer. A workspace scopes its members (users)
// and its peons. Peons connect via overseer-minted credentials (credentials.ts).
// People join via shareable invite links (workspace_invitations), not email invites.

export type Role = "owner" | "member";

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}
export interface WorkspaceWithRole extends WorkspaceRecord {
  role: Role;
}
export interface MemberRecord {
  userId: string;
  email: string;
  role: Role;
  addedAt: number;
}
export interface InviteRecord {
  id: string;
  workspaceId: string;
  token: string;
  role: Role;
  createdAt: number;
  expiresAt: number | null;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
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
  await query(`INSERT INTO workspaces (id, name, slug, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    name,
    slug,
    ownerUserId,
    now,
  ]);
  await query(`INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, $2, 'owner', $3)`, [id, ownerUserId, now]);
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
  const { rows } = await query<{ user_id: string; email: string; role: Role; added_at: number }>(
    `SELECT m.user_id, u.email, m.role, m.added_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY m.added_at ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({ userId: r.user_id, email: r.email, role: r.role, addedAt: r.added_at }));
}

export async function removeMember(workspaceId: string, userId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
  return (rowCount ?? 0) > 0;
}

// Every user gets a personal workspace on first sign-in so the app is never empty.
export async function ensureDefaultWorkspace(userId: string, email: string): Promise<void> {
  const { rows } = await query(`SELECT 1 FROM workspace_members WHERE user_id = $1`, [userId]);
  if (rows.length > 0) return;
  const name = `${email.split("@")[0]}'s workspace`;
  await createWorkspace(name, userId);
}

// ---- invitations (shareable join links) ---------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

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
  role: Role;
  created_at: number;
  expires_at: number | null;
}
function rowToInvite(r: InviteRow): InviteRecord {
  return { id: r.id, workspaceId: r.workspace_id, token: r.token, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at };
}

// Multi-use link: anyone with it can join until it expires or is revoked.
export async function createInvite(workspaceId: string, role: Role, createdBy: string): Promise<InviteRecord> {
  const id = randomUUID();
  const token = newInviteToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  await query(
    `INSERT INTO workspace_invitations (id, workspace_id, token, role, created_by, created_at, expires_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
    [id, workspaceId, token, role, createdBy, now, expiresAt],
  );
  return { id, workspaceId, token, role, createdAt: now, expiresAt };
}

export async function listInvites(workspaceId: string): Promise<InviteRecord[]> {
  const { rows } = await query<InviteRow>(
    `SELECT id, workspace_id, token, role, created_at, expires_at
       FROM workspace_invitations
      WHERE workspace_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
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
      WHERE i.token = $1 AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > $2)`,
    [token, Date.now()],
  );
  const r = rows[0];
  return r ? { workspaceId: r.workspace_id, workspaceName: r.name, role: r.role } : null;
}

export type AcceptResult = { ok: true; workspace: WorkspaceWithRole; alreadyMember: boolean } | { ok: false };

// Consume an invite for an authenticated user: idempotently add them as a member.
export async function acceptInvite(token: string, userId: string): Promise<AcceptResult> {
  const preview = await getInvitePreview(token);
  if (!preview) return { ok: false };
  const existing = await membership(preview.workspaceId, userId);
  if (!existing) {
    await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, added_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [preview.workspaceId, userId, preview.role, Date.now()],
    );
  }
  const { rows } = await query<{ id: string; name: string; slug: string; created_at: number; role: Role }>(
    `SELECT w.id, w.name, w.slug, w.created_at, m.role
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      WHERE w.id = $1 AND m.user_id = $2`,
    [preview.workspaceId, userId],
  );
  const w = rows[0];
  if (!w) return { ok: false };
  return {
    ok: true,
    alreadyMember: !!existing,
    workspace: { id: w.id, name: w.name, slug: w.slug, createdAt: w.created_at, role: w.role },
  };
}
