import { randomBytes, randomUUID } from "node:crypto";
import { query } from "./db.js";
import { evictPeonConnection } from "./peonConnections.js";
import { evictPeonTransferConnection } from "./peonTransferConnections.js";

// Peon credentials — the recruitment tokens. The overseer mints a token scoped to
// a workspace; the peon presents it to register/heartbeat/push, and the overseer
// presents it back when calling the peon (symmetric secret → stored raw, tailnet
// only). The token carries the workspace membership.

export interface PeonCredential {
  id: string;
  workspaceId: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
  boundPeonId: string | null;
}

export interface Minted {
  credential: PeonCredential;
  token: string; // returned exactly once, at mint time
}

function newToken(): string {
  return `pn_${randomBytes(24).toString("base64url")}`;
}

interface CredentialRow {
  id: string;
  workspace_id: string;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
  bound_peon_id: string | null;
}

function rowToCredential(r: CredentialRow): PeonCredential {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    label: r.label,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    boundPeonId: r.bound_peon_id,
  };
}

const COLS = `id, workspace_id, label, created_at, revoked_at, bound_peon_id`;

// Mint a fresh recruitment token for a workspace. Returns the raw token once.
export async function mintCredential(workspaceId: string, label: string | null, createdBy: string): Promise<Minted> {
  const id = randomUUID();
  const token = newToken();
  const now = Date.now();
  await query(
    `INSERT INTO peon_credentials (id, workspace_id, token, label, created_by, created_at, revoked_at, bound_peon_id)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)`,
    [id, workspaceId, token, label, createdBy, now],
  );
  return { credential: { id, workspaceId, label, createdAt: now, revokedAt: null, boundPeonId: null }, token };
}

// Auth gate for north-bound peon calls: null for unknown/revoked tokens ⇒ 401.
export async function resolveCredential(token: string): Promise<PeonCredential | null> {
  if (!token) return null;
  const { rows } = await query<CredentialRow>(
    `SELECT ${COLS} FROM peon_credentials WHERE token = $1 AND revoked_at IS NULL`,
    [token],
  );
  return rows[0] ? rowToCredential(rows[0]) : null;
}

export async function bindPeon(credentialId: string, peonId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE peon_credentials SET bound_peon_id = $2 WHERE id = $1 AND (bound_peon_id IS NULL OR bound_peon_id = $2)`,
    [credentialId, peonId],
  );
  return (rowCount ?? 0) > 0;
}

// Revoke a credential — the peon's token stops authenticating on its next call.
export async function revokeCredential(workspaceId: string, credentialId: string): Promise<boolean> {
  const { rows, rowCount } = await query<{ bound_peon_id: string | null }>(
    `UPDATE peon_credentials SET revoked_at = $3 WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING bound_peon_id`,
    [credentialId, workspaceId, Date.now()],
  );
  if (rows[0]?.bound_peon_id) {
    evictPeonConnection(rows[0].bound_peon_id);
    evictPeonTransferConnection(rows[0].bound_peon_id);
  }
  return (rowCount ?? 0) > 0;
}

// Revoke a peon's credential when it's removed, so its token can't re-register it.
export async function revokeCredentialForPeon(workspaceId: string, peonId: string): Promise<void> {
  await query(
    `UPDATE peon_credentials SET revoked_at = $3 WHERE workspace_id = $1 AND bound_peon_id = $2 AND revoked_at IS NULL`,
    [workspaceId, peonId, Date.now()],
  );
  evictPeonConnection(peonId);
  evictPeonTransferConnection(peonId);
}
