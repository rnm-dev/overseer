import { query } from "./db.js";
import { isPeonConnected, peonConnectionStartedAt } from "./peonConnections.js";
import { isPeonTransferConnected, peonTransferConnectionStartedAt } from "./peonTransferConnections.js";

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
  publicUrl: string | null;
  addressSource: AddressSource;
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

export type AddressSource = "paired" | "manual" | "advertised" | "discovered";

export interface PeonLoad {
  activeSessions: number;
  paused: boolean;
  uptimeSec: number;
}

// The operator-facing shape: never leak the raw credential token.
export type PeonView = Omit<PeonRecord, "token"> & {
  online: boolean;
  controlConnected: boolean;
  transferConnected: boolean;
  controlConnectedAt: number | null;
  transferConnectedAt: number | null;
  baseUrl: string;
};

interface PeonRow {
  peon_id: string;
  credential_id: string;
  workspace_id: string;
  name: string;
  hostname: string | null;
  address: string;
  control_port: number;
  public_url: string | null;
  address_source: AddressSource;
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
    publicUrl: r.public_url ?? null,
    addressSource: r.address_source ?? (r.connection_pinned ? "manual" : "discovered"),
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
  publicUrl?: string | null;
  protocol: number | null;
  capabilities: string[];
  token: string;
  load: PeonLoad | null;
}

export const registry = {
  // Upsert liveness and capabilities. Authenticated advertised/legacy addresses
  // may improve a discovery-only row, but registration can never downgrade an
  // operator-owned paired/manual canonical URL.
  async register(input: RegisterInput): Promise<PeonRecord> {
    const now = Date.now();
    const advertised = input.publicUrl ? urlParts(input.publicUrl) : null;
    const incomingSource: AddressSource = advertised || input.hostname ? "advertised" : "discovered";
    const incomingAddress = advertised?.hostname ?? input.hostname ?? input.address;
    const incomingPort = advertised?.port ?? input.controlPort;
    const { rows } = await query<PeonRow>(
      `INSERT INTO peons (peon_id, credential_id, workspace_id, name, hostname, address, control_port, public_url, address_source, protocol, capabilities, token, load, registered_at, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
       ON CONFLICT (peon_id) DO UPDATE SET
         credential_id = EXCLUDED.credential_id, workspace_id = EXCLUDED.workspace_id,
         name = EXCLUDED.name, hostname = EXCLUDED.hostname,
         address = CASE
           WHEN peons.address_source IN ('paired', 'manual') THEN peons.address
           WHEN peons.address_source = 'advertised' AND EXCLUDED.address_source = 'discovered' THEN peons.address
           ELSE EXCLUDED.address END,
         control_port = CASE
           WHEN peons.address_source IN ('paired', 'manual') THEN peons.control_port
           WHEN peons.address_source = 'advertised' AND EXCLUDED.address_source = 'discovered' THEN peons.control_port
           ELSE EXCLUDED.control_port END,
         public_url = CASE
           WHEN peons.address_source IN ('paired', 'manual') THEN peons.public_url
           WHEN EXCLUDED.public_url IS NOT NULL THEN EXCLUDED.public_url
           ELSE peons.public_url END,
         address_source = CASE
           WHEN peons.address_source IN ('paired', 'manual') THEN peons.address_source
           WHEN peons.address_source = 'advertised' AND EXCLUDED.address_source = 'discovered' THEN peons.address_source
           ELSE EXCLUDED.address_source END,
         protocol = EXCLUDED.protocol,
         capabilities = EXCLUDED.capabilities, token = EXCLUDED.token, load = EXCLUDED.load,
         last_seen = EXCLUDED.last_seen
       RETURNING *`,
      [input.peonId, input.credentialId, input.workspaceId, input.name, input.hostname, incomingAddress, incomingPort, input.publicUrl, incomingSource, input.protocol, JSON.stringify(input.capabilities), input.token, input.load ? JSON.stringify(input.load) : null, now],
    );
    return rowToRecord(rows[0]);
  },

  // Enrollment can race registration in either direction. This upsert creates an
  // offline pending row when registration is delayed, or atomically promotes the
  // already-registered row to the operator-entered paired URL.
  async confirmPairing(input: { peonId: string; credentialId: string; workspaceId: string; token: string; publicUrl: string; name?: string | null }): Promise<PeonRecord> {
    const now = Date.now();
    const parts = urlParts(input.publicUrl);
    if (!parts) throw new Error("invalid canonical Peon URL");
    const { rows } = await query<PeonRow>(
      `INSERT INTO peons (peon_id, credential_id, workspace_id, name, hostname, address, control_port, public_url, address_source, protocol, capabilities, token, load, connection_pinned, registered_at, last_seen)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, 'paired', NULL, '[]', $8, NULL, TRUE, $9, 0)
       ON CONFLICT (peon_id) DO UPDATE SET
         credential_id = EXCLUDED.credential_id, workspace_id = EXCLUDED.workspace_id,
         address = EXCLUDED.address, control_port = EXCLUDED.control_port,
         public_url = EXCLUDED.public_url, address_source = 'paired',
         connection_pinned = TRUE, token = EXCLUDED.token
       RETURNING *`,
      [input.peonId, input.credentialId, input.workspaceId, input.name || input.peonId, parts.hostname, parts.port, input.publicUrl, input.token, now],
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
  async updateConnection(peonId: string, publicUrl: string): Promise<PeonRecord | null> {
    const parts = urlParts(publicUrl);
    if (!parts) return null;
    const { rows } = await query<PeonRow>(
      `UPDATE peons SET address = $2, control_port = $3, public_url = $4, address_source = 'manual', connection_pinned = TRUE WHERE peon_id = $1 RETURNING *`,
      [peonId, parts.hostname, parts.port, publicUrl],
    );
    return rows.length ? rowToRecord(rows[0]) : null;
  },

  // Settings live on the Peon, but fleet lists are registry-backed. Mirror a
  // successfully saved display name so the dashboard does not keep showing the
  // hostname captured at registration until the Peon restarts and re-registers.
  async updateName(peonId: string, name: string): Promise<PeonRecord | null> {
    const { rows } = await query<PeonRow>(
      `UPDATE peons SET name = $2 WHERE peon_id = $1 RETURNING *`,
      [peonId, name],
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
  if (record.publicUrl) return record.publicUrl;
  const host = record.address.includes(":") ? `[${record.address}]` : record.address;
  return `http://${host}:${record.controlPort}`;
}

function urlParts(publicUrl: string): { hostname: string; port: number } | null {
  try {
    const url = new URL(publicUrl);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return url.hostname ? { hostname: url.hostname, port } : null;
  } catch {
    return null;
  }
}

export function toView(record: PeonRecord): PeonView {
  const { token: _token, ...rest } = record;
  const controlConnected = isPeonConnected(record.peonId);
  return {
    ...rest,
    online: controlConnected,
    controlConnected,
    transferConnected: isPeonTransferConnected(record.peonId),
    controlConnectedAt: controlConnected ? peonConnectionStartedAt(record.peonId) : null,
    transferConnectedAt: peonTransferConnectionStartedAt(record.peonId),
    baseUrl: baseUrl(record),
  };
}
