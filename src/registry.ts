import { config } from "./config.js";
import { query } from "./db.js";

// The peon registry — Postgres-backed (`peons` table). `online` and `baseUrl` are
// derived, never stored.
export interface PeonRecord {
  peonId: string;
  credentialId: string;
  workspaceId: string;
  name: string;
  hostname: string | null;
  // The register request's source address (peon's tailnet IP) + reported
  // controlPort — where the overseer calls back. NAT'd peons need no public address.
  address: string;
  controlPort: number;
  protocol: number | null;
  capabilities: string[];
  // The credential's token, presented back when the overseer calls this peon.
  token: string;
  // Operator pinned address/controlPort — register() won't overwrite them.
  connectionPinned: boolean;
  registeredAt: number;
  lastSeen: number;
  load: PeonLoad | null;
}

export interface PeonLoad {
  activeSessions: number;
  paused: boolean;
  uptimeSec: number;
}

// The operator-facing shape: never leak the raw credential token.
export type PeonView = Omit<PeonRecord, "token"> & { online: boolean; baseUrl: string };

interface PeonRow {
  peon_id: string;
  credential_id: string;
  workspace_id: string;
  name: string;
  hostname: string | null;
  address: string;
  control_port: number;
  protocol: number | null;
  capabilities: string[];
  token: string;
  connection_pinned: boolean;
  load: PeonLoad | null;
  registered_at: number;
  last_seen: number;
}

function rowToRecord(r: PeonRow): PeonRecord {
  return {
    peonId: r.peon_id,
    credentialId: r.credential_id,
    workspaceId: r.workspace_id,
    name: r.name,
    hostname: r.hostname,
    address: r.address,
    controlPort: r.control_port,
    protocol: r.protocol,
    capabilities: r.capabilities ?? [],
    token: r.token,
    connectionPinned: r.connection_pinned ?? false,
    registeredAt: r.registered_at,
    lastSeen: r.last_seen,
    load: r.load ?? null,
  };
}

export interface RegisterInput {
  peonId: string;
  credentialId: string;
  workspaceId: string;
  name: string;
  hostname: string | null;
  address: string;
  controlPort: number;
  protocol: number | null;
  capabilities: string[];
  token: string;
  load: PeonLoad | null;
}

export const registry = {
  // Upsert on register; registered_at is preserved, everything else refreshed.
  async register(input: RegisterInput): Promise<PeonRecord> {
    const now = Date.now();
    const { rows } = await query<PeonRow>(
      `INSERT INTO peons (peon_id, credential_id, workspace_id, name, hostname, address, control_port, protocol, capabilities, token, load, registered_at, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       ON CONFLICT (peon_id) DO UPDATE SET
         credential_id = EXCLUDED.credential_id, workspace_id = EXCLUDED.workspace_id,
         name = EXCLUDED.name, hostname = EXCLUDED.hostname,
         -- A pinned connection is operator-owned: keep it, don't clobber with the
         -- NAT-observed source / self-reported port.
         address = CASE WHEN peons.connection_pinned THEN peons.address ELSE EXCLUDED.address END,
         control_port = CASE WHEN peons.connection_pinned THEN peons.control_port ELSE EXCLUDED.control_port END,
         protocol = EXCLUDED.protocol,
         capabilities = EXCLUDED.capabilities, token = EXCLUDED.token, load = EXCLUDED.load,
         last_seen = EXCLUDED.last_seen
       RETURNING *`,
      [input.peonId, input.credentialId, input.workspaceId, input.name, input.hostname, input.address, input.controlPort, input.protocol, JSON.stringify(input.capabilities), input.token, input.load ? JSON.stringify(input.load) : null, now],
    );
    return rowToRecord(rows[0]);
  },

  // Touch last_seen + load, scoped to the presenting credential. Null (⇒ 404,
  // peon re-registers) for an unknown peon or a credential/peon mismatch.
  async heartbeat(peonId: string, credentialId: string, load: PeonLoad | null): Promise<PeonRecord | null> {
    const { rows } = await query<PeonRow>(
      `UPDATE peons SET last_seen = $2, load = COALESCE($3, load) WHERE peon_id = $1 AND credential_id = $4 RETURNING *`,
      [peonId, Date.now(), load ? JSON.stringify(load) : null, credentialId],
    );
    return rows.length ? rowToRecord(rows[0]) : null;
  },

  // Operator override of the call-back location (address / control port). Pins the
  // connection so a subsequent register() won't overwrite it (survives peon
  // restarts). Null ⇒ unknown peon.
  async updateConnection(peonId: string, patch: { address?: string; controlPort?: number }): Promise<PeonRecord | null> {
    const { rows } = await query<PeonRow>(
      `UPDATE peons SET address = COALESCE($2, address), control_port = COALESCE($3, control_port), connection_pinned = TRUE WHERE peon_id = $1 RETURNING *`,
      [peonId, patch.address ?? null, patch.controlPort ?? null],
    );
    return rows.length ? rowToRecord(rows[0]) : null;
  },

  async get(peonId: string): Promise<PeonRecord | undefined> {
    const { rows } = await query<PeonRow>(`SELECT * FROM peons WHERE peon_id = $1`, [peonId]);
    return rows.length ? rowToRecord(rows[0]) : undefined;
  },

  async remove(peonId: string): Promise<boolean> {
    const res = await query(`DELETE FROM peons WHERE peon_id = $1`, [peonId]);
    return (res.rowCount ?? 0) > 0;
  },

  // No workspaceId ⇒ every peon (used by the reconcile loop).
  async list(workspaceId?: string): Promise<PeonRecord[]> {
    const { rows } = workspaceId
      ? await query<PeonRow>(`SELECT * FROM peons WHERE workspace_id = $1 ORDER BY name`, [workspaceId])
      : await query<PeonRow>(`SELECT * FROM peons ORDER BY name`);
    return rows.map(rowToRecord);
  },
};

export function baseUrl(record: PeonRecord): string {
  const host = record.address.includes(":") ? `[${record.address}]` : record.address;
  return `http://${host}:${record.controlPort}`;
}

export function toView(record: PeonRecord): PeonView {
  const { token: _token, ...rest } = record;
  return { ...rest, online: Date.now() - record.lastSeen <= config.offlineAfterMs, baseUrl: baseUrl(record) };
}
