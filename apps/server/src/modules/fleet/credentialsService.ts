import { randomBytes, randomUUID } from "node:crypto";
import { query, transaction } from "../../infrastructure/db/index.js";
import { evictPeonConnection } from "./peonConnections.js";
import type { Minted, PeonCredential } from "./credentialsTypes.js";

interface CredentialRow {
  id: string;
  workspace_id: string;
  label: string | null;
  created_at: number;
  revoked_at: number | null;
  bound_peon_id: string | null;
}

function newToken(): string {
  return `pn_${randomBytes(24).toString("base64url")}`;
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

export async function revokeCredential(workspaceId: string, credentialId: string): Promise<boolean> {
  const { rows, rowCount } = await query<{ bound_peon_id: string | null }>(
    `UPDATE peon_credentials SET revoked_at = $3 WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING bound_peon_id`,
    [credentialId, workspaceId, Date.now()],
  );
  if (rows[0]?.bound_peon_id) {
    evictPeonConnection(rows[0].bound_peon_id);
  }
  return (rowCount ?? 0) > 0;
}

export async function revokeCredentialForPeon(workspaceId: string, peonId: string): Promise<void> {
  await query(
    `UPDATE peon_credentials SET revoked_at=$3
     WHERE workspace_id=$1 AND bound_peon_id=$2 AND revoked_at IS NULL`,
    [workspaceId, peonId, Date.now()],
  );
  evictPeonConnection(peonId);
}

export async function deRecruitPeon(workspaceId: string, peonId: string): Promise<boolean> {
  const removed = await transaction(async (tx) => {
    await tx.query(
      `UPDATE peon_credentials SET revoked_at=$3
       WHERE workspace_id=$1 AND bound_peon_id=$2 AND revoked_at IS NULL`,
      [workspaceId, peonId, Date.now()],
    );
    const result = await tx.query(
      `DELETE FROM peons WHERE peon_id=$1 AND workspace_id=$2`,
      [peonId, workspaceId],
    );
    return (result.rowCount ?? 0) > 0;
  });
  if (removed) {
    evictPeonConnection(peonId);
  }
  return removed;
}
