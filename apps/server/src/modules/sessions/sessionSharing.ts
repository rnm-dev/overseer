import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { query, transaction, type Transaction } from "../../infrastructure/db/index.js";
import { canAccessIndexedSessionNow } from "../access/index.js";
import type { AuthContext } from "../auth/index.js";
import { sessionSharingBus } from "./sessionSharingBus.js";
import {
  type SessionAcceptance,
  type SessionInvitationAccess,
  type SessionInvitationInput,
  type SessionInvitationPreview,
  type SessionInvitationView,
  type SessionParticipantAuth,
  type SessionParticipantProvenance,
  type SessionParticipantStatus,
  type SessionParticipantUsage,
  type SessionParticipantView,
  type SessionSharingLimits,
  type SessionUsageQuality,
  SessionSharingError,
} from "./sessionSharingTypes.js";

export const SESSION_PARTICIPANT_COOKIE = "__Host-overseer_session_participant";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

export const SESSION_INVITATION_DEFAULTS: SessionSharingLimits & { expiresInMs: number } = {
  maxTurns: 10,
  maxDurationMs: 24 * 60 * 60 * 1_000,
  maxTokens: 100_000,
  maxCostMicros: 5_000_000,
  expiresInMs: 7 * 24 * 60 * 60 * 1_000,
};

export const SESSION_INVITATION_HARD_MAXIMA: SessionSharingLimits & { expiresInMs: number } = {
  maxTurns: 100,
  maxDurationMs: 30 * 24 * 60 * 60 * 1_000,
  maxTokens: 5_000_000,
  maxCostMicros: 100_000_000,
  expiresInMs: 30 * 24 * 60 * 60 * 1_000,
};

const MIN_INVITATION_TTL_MS = 5 * 60 * 1_000;
const MIN_PARTICIPANT_DURATION_MS = 5 * 60 * 1_000;
const MAX_NAME_CODE_POINTS = 80;
const MAX_TOKEN_LENGTH = 256;

interface InvitationRow {
  id: string;
  workspace_id: string;
  peon_id: string;
  session_id: string;
  display_name: string;
  access_mode: SessionInvitationAccess;
  max_turns: number;
  max_duration_ms: number;
  max_tokens: number;
  max_cost_micros: number;
  created_by: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface ParticipantRow {
  id: string;
  workspace_id: string;
  peon_id: string;
  session_id: string;
  invitation_id: string | null;
  user_id: string | null;
  guest_id: string | null;
  display_name: string;
  access_mode: SessionInvitationAccess;
  provenance: SessionParticipantProvenance;
  joined_at: number;
  last_active_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  max_turns: number | null;
  max_duration_ms: number | null;
  max_tokens: number | null;
  max_cost_micros: number | null;
  turns_used: number;
  tokens_used: number;
  cost_micros_used: number;
  usage_quality: SessionUsageQuality;
  email: string | null;
  github_login: string | null;
  avatar_url: string | null;
}

interface CredentialParticipantRow extends ParticipantRow {
  credential_expires_at: number;
  credential_revoked_at: number | null;
}

interface SessionRow {
  title: string | null;
  status: string | null;
}

export interface CreatedSessionInvitation {
  invitation: SessionInvitationView;
  token: string;
}

export interface ParticipantAdmission {
  participant: SessionParticipantAuth;
  credential: { token: string; expiresAt: number } | null;
}

export type SessionParticipantRequestAction = "read" | "participate" | "turn" | "manage" | "invalid";

export interface ParticipantRequestAuthorization {
  action: SessionParticipantRequestAction;
  commandId: string | null;
  reserved: boolean;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Exported for focused token-storage tests; callers should pass only a raw capability. */
export function hashSessionCapability(raw: string): string {
  return sha256(raw);
}

function capability(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function numberValue(value: unknown, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new SessionSharingError(`${field} is outside the supported bounds`, "BAD_REQUEST", 400);
  }
  return parsed;
}

export function normalizeGuestDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let normalized: string;
  try {
    normalized = value.normalize("NFKC");
  } catch {
    return null;
  }
  normalized = normalized
    // Line/control separators become ordinary spacing so two words cannot be
    // silently joined; zero-width formatting characters are removed.
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(normalized);
  if (codePoints.length < 1 || codePoints.length > MAX_NAME_CODE_POINTS) return null;
  return codePoints.join("");
}

function limitsFromInput(input: SessionInvitationInput): SessionSharingLimits & { expiresInMs: number } {
  const maxTurns = numberValue(input.maxTurns, SESSION_INVITATION_DEFAULTS.maxTurns, "maxTurns", 1, SESSION_INVITATION_HARD_MAXIMA.maxTurns);
  const maxDurationMs = numberValue(
    input.maxDurationMs,
    SESSION_INVITATION_DEFAULTS.maxDurationMs,
    "maxDurationMs",
    MIN_PARTICIPANT_DURATION_MS,
    SESSION_INVITATION_HARD_MAXIMA.maxDurationMs,
  );
  const maxTokens = numberValue(input.maxTokens, SESSION_INVITATION_DEFAULTS.maxTokens, "maxTokens", 0, SESSION_INVITATION_HARD_MAXIMA.maxTokens);
  const maxCostMicros = numberValue(input.maxCostMicros, SESSION_INVITATION_DEFAULTS.maxCostMicros, "maxCostMicros", 0, SESSION_INVITATION_HARD_MAXIMA.maxCostMicros);
  const expiresInMs = numberValue(
    input.expiresInMs,
    SESSION_INVITATION_DEFAULTS.expiresInMs,
    "expiresInMs",
    MIN_INVITATION_TTL_MS,
    SESSION_INVITATION_HARD_MAXIMA.expiresInMs,
  );
  return { maxTurns, maxDurationMs, maxTokens, maxCostMicros, expiresInMs };
}

function invitationView(row: InvitationRow, participantCount = 0, activeParticipantCount = 0, now = Date.now()): SessionInvitationView {
  const status: SessionParticipantStatus = row.revoked_at ? "revoked" : row.expires_at <= now ? "expired" : "active";
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    peonId: row.peon_id,
    sessionId: row.session_id,
    displayName: row.display_name,
    accessMode: row.access_mode,
    limits: {
      maxTurns: row.max_turns,
      maxDurationMs: row.max_duration_ms,
      maxTokens: row.max_tokens,
      maxCostMicros: row.max_cost_micros,
    },
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    status,
    participantCount,
    activeParticipantCount,
  };
}

function participantStatus(row: Pick<ParticipantRow, "revoked_at" | "expires_at">, now = Date.now()): SessionParticipantStatus {
  return row.revoked_at ? "revoked" : row.expires_at !== null && row.expires_at <= now ? "expired" : "active";
}

function participantActor(row: Pick<ParticipantRow, "display_name" | "guest_id">, email: string | null): string {
  return email ?? `Guest · ${row.display_name}`;
}

function participantAuth(row: ParticipantRow): SessionParticipantAuth {
  return {
    participantId: row.id,
    invitationId: row.invitation_id,
    workspaceId: row.workspace_id,
    peonId: row.peon_id,
    sessionId: row.session_id,
    accessMode: row.access_mode,
    provenance: row.provenance,
    userId: row.user_id,
    guestId: row.guest_id,
    email: row.email,
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url,
    displayName: row.display_name,
    actor: participantActor(row, row.email),
    isGuest: row.guest_id !== null,
    expiresAt: row.expires_at,
  };
}

export function participantView(
  row: ParticipantRow,
  presence: { status: "online" | "away" | "offline"; lastSeenAt: number | null } = { status: "offline", lastSeenAt: null },
  now = Date.now(),
): SessionParticipantView {
  const usage: SessionParticipantUsage = {
    turns: row.turns_used,
    tokens: row.tokens_used,
    costMicros: row.cost_micros_used,
    quality: row.usage_quality,
  };
  return {
    participantId: row.id,
    invitationId: row.invitation_id,
    identity: {
      kind: row.user_id ? "authenticated" : "guest",
      userId: row.user_id,
      guestId: row.guest_id,
      email: row.email,
      githubLogin: row.github_login,
      displayName: row.display_name,
    },
    displayName: row.display_name,
    accessMode: row.access_mode,
    provenance: row.provenance,
    joinedAt: row.joined_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    status: participantStatus(row, now),
    usage,
    presence,
  };
}

function participantSelect(where: string): string {
  return `SELECT p.id,p.workspace_id,p.peon_id,p.session_id,p.invitation_id,p.user_id,p.guest_id,
                 p.display_name,p.access_mode,p.provenance,p.joined_at,p.last_active_at,p.expires_at,p.revoked_at,
                 p.max_turns,p.max_duration_ms,p.max_tokens,p.max_cost_micros,p.turns_used,p.tokens_used,
                 p.cost_micros_used,p.usage_quality,
                 u.email,u.github_login,u.avatar_url
            FROM session_participants p
            LEFT JOIN users u ON u.id=p.user_id
           WHERE ${where}`;
}

async function invitationByHash(tokenHash: string, includeInactive: boolean): Promise<InvitationRow | null> {
  const { rows } = await query<InvitationRow>(
    `SELECT id,workspace_id,peon_id,session_id,display_name,access_mode,max_turns,max_duration_ms,
            max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at
       FROM session_invitations WHERE token_hash=$1`,
    [tokenHash],
  );
  const row = rows[0] ?? null;
  if (!row) return null;
  if (!includeInactive && (row.revoked_at !== null || row.expires_at <= Date.now())) return null;
  return row;
}

async function invitationById(id: string): Promise<InvitationRow | null> {
  const { rows } = await query<InvitationRow>(
    `SELECT id,workspace_id,peon_id,session_id,display_name,access_mode,max_turns,max_duration_ms,
            max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at
       FROM session_invitations WHERE id=$1`,
    [id],
  );
  return rows[0] ?? null;
}

async function invitationCounts(invitationId: string): Promise<{ count: number; activeCount: number }> {
  const { rows } = await query<{ count: number; active_count: number }>(
    `SELECT COUNT(*)::int AS count,
            SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) THEN 1 ELSE 0 END)::int AS active_count
       FROM session_participants WHERE invitation_id=$1`,
    [invitationId, Date.now()],
  );
  return { count: rows[0]?.count ?? 0, activeCount: rows[0]?.active_count ?? 0 };
}

export function sessionParticipantToken(req: Request): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== SESSION_PARTICIPANT_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export function setSessionParticipantCookie(res: Response, token: string, expiresAt: number): void {
  res.cookie(SESSION_PARTICIPANT_COOKIE, token, { ...COOKIE_OPTIONS, expires: new Date(expiresAt) });
}

export function clearSessionParticipantCookie(res: Response): void {
  res.clearCookie(SESSION_PARTICIPANT_COOKIE, COOKIE_OPTIONS);
}

export function participantScopedPath(path: string): boolean {
  return /^\/workspaces\/[^/]+\/peons\/[^/]+\/sessions\/[^/]+(?:\/|$)/u.test(path)
    || /^\/workspaces\/[^/]+\/peons\/[^/]+\/files\/uploads\/[^/]+(?:\/|$)/u.test(path)
    || /^\/workspaces\/[^/]+\/peons\/[^/]+\/attachments$/u.test(path);
}

// The canonical session route carries :sid; attachment uploads/readbacks carry
// it inside the sandbox path. Returning null is intentional: a scoped
// credential must never be allowed through a file route whose session cannot be
// proven from the request itself.
export function participantSessionIdForRequest(req: Request): string | null {
  if (typeof req.params.sid === "string" && req.params.sid.length > 0) return req.params.sid;
  const upload = /\/files\/uploads\/([^/]+)(?:\/|$)/u.exec(req.path);
  if (upload?.[1]) {
    try {
      return decodeURIComponent(upload[1]);
    } catch {
      return null;
    }
  }
  if (/\/attachments$/u.test(req.path) && typeof req.query.path === "string") {
    const match = /(?:^|[/\\])uploads[/\\]([^/\\]+)/u.exec(req.query.path);
    if (match?.[1]) return match[1];
    const sessionAttachment = /(?:^|[/\\])sessions[/\\]([^/\\]+)[/\\]attachments(?:[/\\]|$)/u.exec(req.query.path);
    if (sessionAttachment?.[1]) return sessionAttachment[1];
  }
  return null;
}

export function sessionParticipantRequestAction(req: Request): SessionParticipantRequestAction {
  const path = req.path;
  const method = req.method.toUpperCase();
  const hasSession = typeof req.params.sid === "string" && req.params.sid.length > 0;
  const upload = /\/files\/uploads\/[^/]+(?:\/|$)/u.test(path);
  const attachments = /\/attachments$/u.test(path);
  if (!hasSession && !upload && !attachments) return "invalid";
  // Read access is intentionally transcript-only. The paginated transcript and
  // live tail are readable; session metadata, files, attachments, queues,
  // inquiries and attention mutations belong to participate access.
  if (upload) return method === "GET" ? "participate" : method === "PUT" ? "participate" : "invalid";
  if (attachments) return method === "GET" ? "participate" : "invalid";
  if (path.includes("/branch") || (method === "DELETE" && /\/sessions\/[^/]+$/u.test(path))) return "manage";
  if (method === "GET") {
    return path.endsWith("/transcript") || path.endsWith("/stream") ? "read" : "participate";
  }
  if (method === "POST" && (path.endsWith("/followup") || path.endsWith("/queue"))) return "turn";
  if (method === "POST" && path.endsWith("/attention/read")) return "participate";
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) return "participate";
  return "invalid";
}

function requestCommandId(req: Request): string {
  const header = req.headers["peon-request-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 255 && !/[\r\n]/u.test(header)) return header;
  if (req.path.endsWith("/followup")) throw new SessionSharingError("Peon-Request-Id is required for participant follow-ups", "BAD_REQUEST", 400);
  const body = req.body as { requestId?: unknown; commandId?: unknown } | undefined;
  const bodyId = body?.commandId ?? body?.requestId;
  if (typeof bodyId === "string" && bodyId.length > 0 && bodyId.length <= 255 && !/[\r\n]/u.test(bodyId)) return bodyId;
  return `implicit:${randomUUID()}`;
}

export async function createSessionInvitation(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  createdBy: string,
  input: SessionInvitationInput,
): Promise<CreatedSessionInvitation> {
  const session = await query(
    `SELECT 1 FROM sessions s JOIN peons p ON p.peon_id=s.peon_id
      WHERE s.peon_id=$1 AND s.session_id=$2 AND p.workspace_id=$3`,
    [peonId, sessionId, workspaceId],
  );
  if (session.rows.length === 0) throw new SessionSharingError("only an existing canonical session can be shared", "UNKNOWN_SESSION", 404);
  const displayName = normalizeGuestDisplayName(input.displayName);
  if (!displayName) throw new SessionSharingError("a bounded guest display name is required", "BAD_REQUEST", 400);
  const accessMode = input.accessMode === undefined ? "participate" : input.accessMode;
  if (accessMode !== "read" && accessMode !== "participate") throw new SessionSharingError("accessMode must be read or participate", "BAD_REQUEST", 400);
  const limits = limitsFromInput(input);
  const now = Date.now();
  const id = randomUUID();
  const token = capability("siv_");
  const row = await query<InvitationRow>(
    `INSERT INTO session_invitations
       (id,workspace_id,peon_id,session_id,token_hash,display_name,access_mode,max_turns,max_duration_ms,
        max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL)
     RETURNING id,workspace_id,peon_id,session_id,display_name,access_mode,max_turns,max_duration_ms,
               max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at`,
    [id, workspaceId, peonId, sessionId, sha256(token), displayName, accessMode, limits.maxTurns, limits.maxDurationMs,
      limits.maxTokens, limits.maxCostMicros, createdBy, now, now + limits.expiresInMs],
  );
  return { invitation: invitationView(row.rows[0]!), token };
}

export async function listSessionInvitations(workspaceId: string, peonId: string, sessionId: string): Promise<SessionInvitationView[]> {
  const { rows } = await query<InvitationRow>(
    `SELECT id,workspace_id,peon_id,session_id,display_name,access_mode,max_turns,max_duration_ms,
            max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at
       FROM session_invitations
      WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3
      ORDER BY created_at DESC`,
    [workspaceId, peonId, sessionId],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const counts = await query<{ invitation_id: string; count: number; active_count: number }>(
    `SELECT invitation_id,COUNT(*)::int AS count,
            SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) THEN 1 ELSE 0 END)::int AS active_count
       FROM session_participants WHERE invitation_id = ANY($1) GROUP BY invitation_id`,
    [ids, Date.now()],
  );
  const byId = new Map(counts.rows.map((row) => [row.invitation_id, row]));
  return rows.map((row) => invitationView(row, byId.get(row.id)?.count ?? 0, byId.get(row.id)?.active_count ?? 0));
}

export async function getSessionInvitation(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  invitationId: string,
): Promise<SessionInvitationView | null> {
  const row = await invitationById(invitationId);
  if (!row || row.workspace_id !== workspaceId || row.peon_id !== peonId || row.session_id !== sessionId) return null;
  const counts = await invitationCounts(row.id);
  return invitationView(row, counts.count, counts.activeCount);
}

export async function updateSessionInvitation(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  invitationId: string,
  input: SessionInvitationInput,
): Promise<SessionInvitationView | null> {
  const current = await invitationById(invitationId);
  if (!current || current.workspace_id !== workspaceId || current.peon_id !== peonId || current.session_id !== sessionId) return null;
  if (current.revoked_at !== null) throw new SessionSharingError("revoked invitations cannot be edited", "INVITATION_REVOKED", 409);
  const displayName = input.displayName === undefined ? current.display_name : normalizeGuestDisplayName(input.displayName);
  if (!displayName) throw new SessionSharingError("a bounded guest display name is required", "BAD_REQUEST", 400);
  const accessMode = input.accessMode === undefined ? current.access_mode : input.accessMode;
  if (accessMode !== "read" && accessMode !== "participate") throw new SessionSharingError("accessMode must be read or participate", "BAD_REQUEST", 400);
  const limits = limitsFromInput({
    displayName,
    maxTurns: input.maxTurns ?? current.max_turns,
    maxDurationMs: input.maxDurationMs ?? current.max_duration_ms,
    maxTokens: input.maxTokens ?? current.max_tokens,
    maxCostMicros: input.maxCostMicros ?? current.max_cost_micros,
    expiresInMs: input.expiresInMs ?? Math.max(MIN_INVITATION_TTL_MS, current.expires_at - Date.now()),
  });
  if (current.expires_at <= Date.now() && input.expiresInMs === undefined) throw new SessionSharingError("expired invitations cannot be edited without a new expiry", "INVITATION_EXPIRED", 409);
  const expiresAt = input.expiresInMs === undefined ? current.expires_at : Date.now() + limits.expiresInMs;
  const { rows } = await query<InvitationRow>(
    `UPDATE session_invitations
        SET display_name=$5,access_mode=$6,max_turns=$7,max_duration_ms=$8,max_tokens=$9,max_cost_micros=$10,expires_at=$11
      WHERE id=$1 AND workspace_id=$2 AND peon_id=$3 AND session_id=$4 AND revoked_at IS NULL
      RETURNING id,workspace_id,peon_id,session_id,display_name,access_mode,max_turns,max_duration_ms,max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at`,
    [invitationId, workspaceId, peonId, sessionId, displayName, accessMode, limits.maxTurns, limits.maxDurationMs, limits.maxTokens, limits.maxCostMicros, expiresAt],
  );
  if (!rows[0]) return null;
  const counts = await invitationCounts(invitationId);
  return invitationView(rows[0], counts.count, counts.activeCount);
}

export async function revokeSessionInvitation(workspaceId: string, peonId: string, sessionId: string, invitationId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE session_invitations SET revoked_at=$5
      WHERE id=$1 AND workspace_id=$2 AND peon_id=$3 AND session_id=$4 AND revoked_at IS NULL`,
    [invitationId, workspaceId, peonId, sessionId, Date.now()],
  );
  return (rowCount ?? 0) > 0;
}

async function directAccess(auth: AuthContext, invitation: InvitationRow): Promise<boolean> {
  return canAccessIndexedSessionNow(invitation.workspace_id, auth.userId, invitation.peon_id, invitation.session_id);
}

export async function getSessionInvitationPreview(token: string, auth: AuthContext | null): Promise<SessionInvitationPreview | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const invitation = await invitationByHash(sha256(token), true);
  if (!invitation) return null;
  const session = await query<SessionRow>(`SELECT title,status FROM sessions WHERE peon_id=$1 AND session_id=$2`, [invitation.peon_id, invitation.session_id]);
  return {
    ...invitationView(invitation),
    sessionTitle: session.rows[0]?.title ?? null,
    sessionStatus: session.rows[0]?.status ?? null,
    // A normal member's access is independent of the capability's lifecycle.
    // This keeps an authenticated operator on the canonical session even when
    // they follow an invitation that has since expired or been revoked.
    alreadyAuthorized: auth ? await directAccess(auth, invitation) : false,
  };
}

async function participantById(participantId: string, activeOnly: boolean): Promise<ParticipantRow | null> {
  const { rows } = await query<ParticipantRow>(participantSelect(`p.id=$1`), [participantId]);
  const row = rows[0] ?? null;
  if (!row) return null;
  if (activeOnly && participantStatus(row) !== "active") return null;
  return row;
}

export async function getSessionParticipantForUser(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  userId: string,
): Promise<SessionParticipantAuth | null> {
  const { rows } = await query<ParticipantRow>(
    participantSelect(`p.workspace_id=$1 AND p.peon_id=$2 AND p.session_id=$3 AND p.user_id=$4 ORDER BY p.joined_at DESC LIMIT 1`),
    [workspaceId, peonId, sessionId, userId],
  );
  const row = rows[0];
  return row && participantStatus(row) === "active" ? participantAuth(row) : null;
}

export async function getSessionParticipantByCredential(token: string): Promise<SessionParticipantAuth | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const { rows } = await query<CredentialParticipantRow>(
    `SELECT p.id,p.workspace_id,p.peon_id,p.session_id,p.invitation_id,p.user_id,p.guest_id,
            p.display_name,p.access_mode,p.provenance,p.joined_at,p.last_active_at,p.expires_at,p.revoked_at,
            p.max_turns,p.max_duration_ms,p.max_tokens,p.max_cost_micros,p.turns_used,p.tokens_used,
            p.cost_micros_used,p.usage_quality,
            u.email,u.github_login,u.avatar_url,
            c.expires_at AS credential_expires_at,c.revoked_at AS credential_revoked_at
       FROM session_participant_credentials c
       JOIN session_participants p ON p.id=c.participant_id
       LEFT JOIN users u ON u.id=p.user_id
      WHERE c.token_hash=$1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row || row.credential_revoked_at || row.credential_expires_at <= Date.now() || participantStatus(row) !== "active") return null;
  void query(`UPDATE session_participant_credentials SET last_used_at=$2 WHERE participant_id=$1`, [row.id, Date.now()]).catch(() => undefined);
  return participantAuth(row);
}

async function createParticipant(
  invitation: InvitationRow,
  auth: AuthContext | null,
  guestName: string | null,
  tx: Transaction,
): Promise<string> {
  const now = Date.now();
  const userId = auth?.userId ?? null;
  const guestId = auth ? null : `guest_${randomUUID()}`;
  const displayName = auth ? (auth.githubLogin || auth.email) : guestName!;
  const id = randomUUID();
  const expiresAt = now + invitation.max_duration_ms;
  await tx.query(
    `INSERT INTO session_participants
       (id,workspace_id,peon_id,session_id,invitation_id,user_id,guest_id,display_name,access_mode,provenance,
        joined_at,last_active_at,expires_at,revoked_at,max_turns,max_duration_ms,max_tokens,max_cost_micros,
        turns_used,tokens_used,cost_micros_used,usage_updated_at,usage_quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'invitation',$10,$10,$11,NULL,$12,$13,$14,$15,0,0,0,NULL,'unknown')
     ON CONFLICT DO NOTHING`,
    [id, invitation.workspace_id, invitation.peon_id, invitation.session_id, invitation.id, userId, guestId, displayName,
      invitation.access_mode, now, expiresAt, invitation.max_turns, invitation.max_duration_ms, invitation.max_tokens, invitation.max_cost_micros],
  );
  const found = await tx.query<{ id: string }>(
    `SELECT id FROM session_participants WHERE invitation_id=$1 AND ${auth ? "user_id=$2" : "guest_id=$2"} ORDER BY joined_at DESC LIMIT 1`,
    [invitation.id, auth ? userId : guestId],
  );
  if (!found.rows[0]) throw new SessionSharingError("participant admission failed", "ADMISSION_FAILED", 500);
  return found.rows[0].id;
}

export async function acceptSessionInvitation(
  token: string,
  auth: AuthContext | null,
  guestDisplayName: unknown,
  existingCredentialToken: string,
): Promise<SessionAcceptance> {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new SessionSharingError("invalid or expired invitation", "INVALID_INVITATION", 404);
  const invitationRecord = await invitationByHash(sha256(token), true);
  if (!invitationRecord) throw new SessionSharingError("invalid or expired invitation", "INVALID_INVITATION", 404);
  const preview = await getSessionInvitationPreview(token, auth);
  if (!preview) throw new SessionSharingError("invalid or expired invitation", "INVALID_INVITATION", 404);
  const existing = !auth && existingCredentialToken
    ? await getSessionParticipantByCredential(existingCredentialToken)
    : auth
      ? await getSessionParticipantForUser(invitationRecord.workspace_id, invitationRecord.peon_id, invitationRecord.session_id, auth.userId)
      : null;
  const existingAdmitted = Boolean(existing
    && existing.invitationId === invitationRecord.id
    && existing.workspaceId === invitationRecord.workspace_id
    && existing.peonId === invitationRecord.peon_id
    && existing.sessionId === invitationRecord.session_id);
  if (auth && await directAccess(auth, invitationRecord)) {
    return {
      alreadyAuthorized: true,
      workspaceId: invitationRecord.workspace_id,
      peonId: invitationRecord.peon_id,
      sessionId: invitationRecord.session_id,
      sessionTitle: preview.sessionTitle,
      accessMode: null,
      participant: null,
      participantCredential: null,
      webSocketTicket: null,
    };
  }
  if (!existingAdmitted && preview.status === "revoked") throw new SessionSharingError("this invitation was revoked", "INVITATION_REVOKED", 410);
  if (!existingAdmitted && preview.status === "expired") throw new SessionSharingError("this invitation has expired", "INVITATION_EXPIRED", 410);

  const guestName = auth ? null : normalizeGuestDisplayName(guestDisplayName);
  if (!auth && !guestName && !existingAdmitted) throw new SessionSharingError("a bounded guest display name is required", "BAD_REQUEST", 400);
  const invitation = await transaction(async (tx) => {
    const locked = await tx.query<InvitationRow>(
      `SELECT id,workspace_id,peon_id,session_id,display_name,access_mode,max_turns,max_duration_ms,
              max_tokens,max_cost_micros,created_by,created_at,expires_at,revoked_at
         FROM session_invitations WHERE token_hash=$1 FOR UPDATE`,
      [sha256(token)],
    );
    const row = locked.rows[0];
    if (!row) throw new SessionSharingError("invalid or expired invitation", "INVALID_INVITATION", 404);
    if (!existingAdmitted && row.revoked_at !== null) {
      throw new SessionSharingError("this invitation was revoked", "INVITATION_REVOKED", 410);
    }
    if (!existingAdmitted && row.expires_at <= Date.now()) {
      throw new SessionSharingError("this invitation has expired", "INVITATION_EXPIRED", 410);
    }
    return row;
  });

  let participant: SessionParticipantAuth | null = null;
  let credential: { token: string; expiresAt: number } | null = null;
  if (existing && existing.invitationId === invitation.id && existing.workspaceId === invitation.workspace_id
      && existing.peonId === invitation.peon_id && existing.sessionId === invitation.session_id) {
    if (guestName && guestName !== existing.displayName) {
      await query(`UPDATE session_participants SET display_name=$2,last_active_at=$3 WHERE id=$1 AND revoked_at IS NULL`, [existing.participantId, guestName, Date.now()]);
    }
    participant = await participantById(existing.participantId, true).then((row) => row ? participantAuth(row) : null);
    if (participant && !auth) credential = { token: existingCredentialToken, expiresAt: participant.expiresAt ?? Date.now() };
  }
  if (!participant && existingAdmitted) throw new SessionSharingError("participant access is no longer valid", "PARTICIPANT_REVOKED", 403);
  if (!participant) {
    const participantId = await transaction((tx) => createParticipant(invitation, auth, guestName, tx));
    const row = await participantById(participantId, true);
    if (!row) throw new SessionSharingError("participant admission failed", "ADMISSION_FAILED", 500);
    participant = participantAuth(row);
    if (!auth) {
      const raw = capability("spc_");
      await query(
        `INSERT INTO session_participant_credentials (id,participant_id,token_hash,created_at,last_used_at,expires_at,revoked_at)
         VALUES ($1,$2,$3,$4,$4,$5,NULL)`,
        [randomUUID(), participantId, sha256(raw), Date.now(), participant.expiresAt],
      );
      credential = { token: raw, expiresAt: participant.expiresAt! };
    }
  }
  const webSocketTicket = participant ? await issueSessionParticipantWebSocketTicket(participant) : null;
  return {
    alreadyAuthorized: false,
    workspaceId: invitation.workspace_id,
    peonId: invitation.peon_id,
    sessionId: invitation.session_id,
    sessionTitle: preview.sessionTitle,
    accessMode: participant?.accessMode ?? invitation.access_mode,
    participant: participant ? participantView((await participantById(participant.participantId, false))!) : null,
    participantCredential: credential,
    webSocketTicket,
  };
}

export async function ensureDirectSessionParticipant(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  auth: AuthContext,
): Promise<void> {
  const now = Date.now();
  await query(
    `INSERT INTO session_participants
       (id,workspace_id,peon_id,session_id,invitation_id,user_id,guest_id,display_name,access_mode,provenance,
        joined_at,last_active_at,expires_at,revoked_at,max_turns,max_duration_ms,max_tokens,max_cost_micros,
        turns_used,tokens_used,cost_micros_used,usage_updated_at,usage_quality)
     VALUES ($1,$2,$3,$4,NULL,$5,NULL,$6,'participate','direct',$7,$7,NULL,NULL,NULL,NULL,NULL,NULL,0,0,0,NULL,'unknown')
     ON CONFLICT DO NOTHING`,
    [randomUUID(), workspaceId, peonId, sessionId, auth.userId, auth.githubLogin || auth.email, now],
  );
  await query(`UPDATE session_participants SET last_active_at=$5 WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3 AND user_id=$4 AND revoked_at IS NULL`, [workspaceId, peonId, sessionId, auth.userId, now]);
}

export async function listSessionParticipants(workspaceId: string, peonId: string, sessionId: string): Promise<SessionParticipantView[]> {
  const { rows } = await query<ParticipantRow>(
    `${participantSelect(`p.workspace_id=$1 AND p.peon_id=$2 AND p.session_id=$3`)} ORDER BY p.joined_at ASC`,
    [workspaceId, peonId, sessionId],
  );
  return rows.map((row) => participantView(row));
}

export async function revokeSessionParticipant(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  participantId: string,
): Promise<boolean> {
  const now = Date.now();
  const changed = await transaction(async (tx) => {
    const found = await tx.query<{ id: string; provenance: SessionParticipantProvenance }>(
      `SELECT id,provenance FROM session_participants
        WHERE id=$1 AND workspace_id=$2 AND peon_id=$3 AND session_id=$4 FOR UPDATE`,
      [participantId, workspaceId, peonId, sessionId],
    );
    const row = found.rows[0];
    if (!row || row.provenance === "direct") return false;
    const result = await tx.query(`UPDATE session_participants SET revoked_at=$5 WHERE id=$1 AND workspace_id=$2 AND peon_id=$3 AND session_id=$4 AND revoked_at IS NULL`, [participantId, workspaceId, peonId, sessionId, now]);
    if ((result.rowCount ?? 0) > 0) {
      await tx.query(`UPDATE session_participant_credentials SET revoked_at=$2 WHERE participant_id=$1 AND revoked_at IS NULL`, [participantId, now]);
      await tx.query(`DELETE FROM session_participant_ws_tickets WHERE participant_id=$1`, [participantId]);
      return true;
    }
    return false;
  });
  if (changed) sessionSharingBus.emitParticipantRevoked({ participantId, workspaceId, peonId, sessionId });
  return changed;
}

export async function touchSessionParticipant(participantId: string): Promise<void> {
  await query(`UPDATE session_participants SET last_active_at=$2 WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`, [participantId, Date.now()]);
}

export async function authorizeSessionParticipantRequest(
  participant: SessionParticipantAuth,
  req: Request,
): Promise<ParticipantRequestAuthorization> {
  const action = sessionParticipantRequestAction(req);
  if (action === "invalid" || action === "manage") throw new SessionSharingError("participant action is not allowed", "PARTICIPANT_FORBIDDEN", 403);
  if (participantSessionIdForRequest(req) !== participant.sessionId) {
    throw new SessionSharingError("participant is scoped to another session", "PARTICIPANT_SCOPE", 404);
  }
  const commandId = action === "turn" ? requestCommandId(req) : null;
  const result = await transaction(async (tx) => {
    const locked = await tx.query<ParticipantRow>(participantSelect(`p.id=$1`) + " FOR UPDATE", [participant.participantId]);
    const row = locked.rows[0];
    if (!row || row.workspace_id !== participant.workspaceId || row.peon_id !== participant.peonId || row.session_id !== participant.sessionId) {
      throw new SessionSharingError("participant access is no longer valid", "PARTICIPANT_REVOKED", 403);
    }
    const status = participantStatus(row);
    if (status === "revoked") throw new SessionSharingError("participant access was revoked", "PARTICIPANT_REVOKED", 403);
    if (status === "expired") throw new SessionSharingError("participant access has expired", "PARTICIPANT_EXPIRED", 403);
    if (row.access_mode === "read" && action !== "read") throw new SessionSharingError("this invitation is read-only", "PARTICIPANT_READ_ONLY", 403);
    if (action !== "turn") return { reserved: false };
    const duplicate = await tx.query<{ id: string }>(
      `SELECT id FROM session_participant_turn_reservations WHERE participant_id=$1 AND command_id=$2`,
      [row.id, commandId],
    );
    if (duplicate.rows.length > 0) return { reserved: false };
    if (row.max_turns !== null && row.turns_used >= row.max_turns) throw new SessionSharingError("participant turn limit is exhausted", "PARTICIPANT_LIMIT_EXHAUSTED", 429);
    const inserted = await tx.query(
      `INSERT INTO session_participant_turn_reservations (id,participant_id,command_id,reserved_at,status,settled_at)
       VALUES ($1,$2,$3,$4,'admitted',NULL) ON CONFLICT DO NOTHING`,
      [randomUUID(), row.id, commandId, Date.now()],
    );
    if ((inserted.rowCount ?? 0) > 0) await tx.query(`UPDATE session_participants SET turns_used=turns_used+1,last_active_at=$2 WHERE id=$1`, [row.id, Date.now()]);
    return { reserved: (inserted.rowCount ?? 0) > 0 };
  });
  await touchSessionParticipant(participant.participantId);
  return { action, commandId, reserved: result.reserved };
}

export async function issueSessionParticipantWebSocketTicket(participant: SessionParticipantAuth): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = capability("spw_");
  const now = Date.now();
  const expiresAt = now + 30_000;
  await query(`INSERT INTO session_participant_ws_tickets (ticket_hash,participant_id,created_at,expires_at) VALUES ($1,$2,$3,$4)`, [sha256(ticket), participant.participantId, now, expiresAt]);
  void query(`DELETE FROM session_participant_ws_tickets WHERE expires_at < $1`, [now]).catch(() => undefined);
  return { ticket, expiresAt };
}

export async function consumeSessionParticipantWebSocketTicket(ticket: string): Promise<SessionParticipantAuth | null> {
  if (!ticket || ticket.length > MAX_TOKEN_LENGTH) return null;
  const consumed = await query<{ participant_id: string }>(
    `DELETE FROM session_participant_ws_tickets WHERE ticket_hash=$1 AND expires_at >= $2 RETURNING participant_id`,
    [sha256(ticket), Date.now()],
  );
  const id = consumed.rows[0]?.participant_id;
  return id ? getSessionParticipantById(id) : null;
}

export async function getSessionParticipantById(participantId: string): Promise<SessionParticipantAuth | null> {
  const row = await participantById(participantId, true);
  return row ? participantAuth(row) : null;
}

export function invitationErrorResponse(error: unknown): { status: number; body: { error: string; code: string } } | null {
  if (!(error instanceof SessionSharingError)) return null;
  return { status: error.status, body: { error: error.message, code: error.code } };
}
