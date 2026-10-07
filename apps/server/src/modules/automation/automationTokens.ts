import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { query } from "../../infrastructure/db/index.js";
import { AUTOMATION_TOKEN_PREFIX, type AutomationTokenRecord, type AutomationTokenView } from "./automationTokenTypes.js";

const MAX_LABEL_LENGTH = 120;
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 365;
const DAY_MS = 86_400_000;
// A token that has not been used for a whole day is re-stamped at most once a
// day. `lastUsedAt` answers "is anyone still using this?", not "when exactly
// was the last call" — a write per request would be pure noise.
const LAST_USED_RESOLUTION_MS = 3_600_000;

interface TokenRow {
  id: string;
  workspace_id: string;
  peon_id: string;
  project_id: string | null;
  project_key: string | null;
  user_id: string;
  label: string | null;
  created_at: string | number;
  last_used_at: string | number | null;
  expires_at: string | number | null;
  revoked_at: string | number | null;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function hashesMatch(raw: string, storedHex: string): boolean {
  const candidate = Buffer.from(sha256(raw), "hex");
  const actual = Buffer.from(storedHex, "hex");
  return candidate.length === actual.length && timingSafeEqual(candidate, actual);
}

function numeric(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toRecord(row: TokenRow): AutomationTokenRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    peonId: row.peon_id,
    projectId: row.project_id,
    projectKey: row.project_key,
    userId: row.user_id,
    label: row.label,
    createdAt: Number(row.created_at),
    lastUsedAt: numeric(row.last_used_at),
    expiresAt: numeric(row.expires_at),
    revokedAt: numeric(row.revoked_at),
  };
}

export function normalizeTokenLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_LABEL_LENGTH) : null;
}

// `null` means "never expires", which is a deliberate choice an operator can
// make. An out-of-range number is a mistake, not a preference, so it is
// refused rather than clamped into something the operator did not ask for.
export function resolveExpiry(raw: unknown, now = Date.now()): number | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return "invalid";
  if (raw < MIN_EXPIRY_DAYS || raw > MAX_EXPIRY_DAYS) return "invalid";
  return now + raw * DAY_MS;
}

export function parseAutomationToken(token: string): { id: string; secret: string } | null {
  if (!token.startsWith(AUTOMATION_TOKEN_PREFIX)) return null;
  const body = token.slice(AUTOMATION_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot === body.length - 1) return null;
  return { id: body.slice(0, dot), secret: body.slice(dot + 1) };
}

export async function issueAutomationToken(input: {
  workspaceId: string;
  peonId: string;
  projectId: string | null;
  projectKey: string | null;
  userId: string;
  label: string | null;
  expiresAt: number | null;
}): Promise<{ token: string; record: AutomationTokenRecord }> {
  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();
  await query(
    `INSERT INTO automation_tokens
       (id, workspace_id, peon_id, project_id, project_key, user_id, label, token_hash, created_at, last_used_at, expires_at, revoked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,NULL)`,
    [id, input.workspaceId, input.peonId, input.projectId, input.projectKey, input.userId, input.label, sha256(secret), now, input.expiresAt],
  );
  return {
    token: `${AUTOMATION_TOKEN_PREFIX}${id}.${secret}`,
    record: {
      id,
      workspaceId: input.workspaceId,
      peonId: input.peonId,
      projectId: input.projectId,
      projectKey: input.projectKey,
      userId: input.userId,
      label: input.label,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: input.expiresAt,
      revokedAt: null,
    },
  };
}

// Verification proves possession of the secret and nothing more. Whether the
// bearer may touch anything is decided afterwards, against the owner's live
// ACL — see `resolveAutomationRequest`.
export async function verifyAutomationToken(token: string): Promise<AutomationTokenRecord | null> {
  const parsed = parseAutomationToken(token);
  if (!parsed) return null;
  const { rows } = await query<TokenRow & { token_hash: string }>(
    `SELECT id, workspace_id, peon_id, project_id, project_key, user_id, label, token_hash,
            created_at, last_used_at, expires_at, revoked_at
       FROM automation_tokens WHERE id = $1`,
    [parsed.id],
  );
  const row = rows[0];
  if (!row || row.revoked_at !== null) return null;
  const expiresAt = numeric(row.expires_at);
  if (expiresAt !== null && expiresAt < Date.now()) return null;
  if (!hashesMatch(parsed.secret, row.token_hash)) return null;
  const now = Date.now();
  void query(
    `UPDATE automation_tokens SET last_used_at = $2
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)`,
    [row.id, now, now - LAST_USED_RESOLUTION_MS],
  ).catch(() => undefined);
  return toRecord(row);
}

// Every token on one project, for the settings page. A caller who may only see
// their own gets exactly their own; the `mine` flag drives the UI, never the
// authorization decision.
export async function listAutomationTokens(scope: {
  workspaceId: string;
  peonId: string;
  projectId: string | null;
  projectKey: string | null;
  ownerUserId?: string;
}): Promise<AutomationTokenView[]> {
  const params: unknown[] = [scope.workspaceId, scope.peonId];
  const where = ["t.workspace_id = $1", "t.peon_id = $2", "t.revoked_at IS NULL"];
  if (scope.projectId) {
    params.push(scope.projectId);
    where.push(`t.project_id = $${params.length}`);
  } else if (scope.projectKey) {
    params.push(scope.projectKey);
    where.push(`t.project_id IS NULL AND t.project_key = $${params.length}`);
  }
  if (scope.ownerUserId) {
    params.push(scope.ownerUserId);
    where.push(`t.user_id = $${params.length}`);
  }
  const { rows } = await query<TokenRow & { email: string | null }>(
    `SELECT t.id, t.workspace_id, t.peon_id, t.project_id, t.project_key, t.user_id, t.label,
            t.created_at, t.last_used_at, t.expires_at, t.revoked_at, u.email
       FROM automation_tokens t LEFT JOIN users u ON u.id = t.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at DESC`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    peonId: row.peon_id,
    projectKey: row.project_key,
    projectId: row.project_id,
    ownerUserId: row.user_id,
    ownerEmail: row.email,
    createdAt: Number(row.created_at),
    lastUsedAt: numeric(row.last_used_at),
    expiresAt: numeric(row.expires_at),
    mine: scope.ownerUserId ? row.user_id === scope.ownerUserId : false,
  }));
}

export async function getAutomationToken(id: string): Promise<AutomationTokenRecord | null> {
  const { rows } = await query<TokenRow>(
    `SELECT id, workspace_id, peon_id, project_id, project_key, user_id, label,
            created_at, last_used_at, expires_at, revoked_at
       FROM automation_tokens WHERE id = $1`,
    [id],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function revokeAutomationToken(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE automation_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [id, Date.now()],
  );
  return (rowCount ?? 0) > 0;
}

// A Peon that leaves the workspace, or a project that is unregistered, must not
// leave live machine credentials pointing at it.
export async function revokeAutomationTokensForPeon(peonId: string): Promise<void> {
  await query(`UPDATE automation_tokens SET revoked_at = $2 WHERE peon_id = $1 AND revoked_at IS NULL`, [peonId, Date.now()]);
}

export async function revokeAutomationTokensForProject(peonId: string, projectId: string | null, projectKey: string | null): Promise<void> {
  if (projectId) {
    await query(
      `UPDATE automation_tokens SET revoked_at = $3 WHERE peon_id = $1 AND project_id = $2 AND revoked_at IS NULL`,
      [peonId, projectId, Date.now()],
    );
    return;
  }
  if (!projectKey) return;
  await query(
    `UPDATE automation_tokens SET revoked_at = $3 WHERE peon_id = $1 AND project_id IS NULL AND project_key = $2 AND revoked_at IS NULL`,
    [peonId, projectKey, Date.now()],
  );
}
