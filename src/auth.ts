import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { query } from "./db.js";
import { config } from "./config.js";
import type { GithubProfile } from "./github.js";

// Operator/mobile auth. Sign-in is GitHub OAuth (github.ts): the exchange yields a
// GitHub identity, which we resolve to a user row and then mint a long-lived DEVICE
// token — the reusable credential the web/mobile app stores and presents on every
// request and on the (future) WebSocket handshake.
//
// Tokens are compound "id.secret": the id is a plain lookup key so verification is
// one row fetch + one sha256+timingSafeEqual compare, never a table scan. Only the
// sha256 of a secret is ever persisted; the raw value is returned once at issue time.

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function hashesMatch(raw: string, storedHex: string): boolean {
  const candidate = Buffer.from(sha256(raw), "hex");
  const actual = Buffer.from(storedHex, "hex");
  return candidate.length === actual.length && timingSafeEqual(candidate, actual);
}

function parseCompoundToken(token: string): { id: string; raw: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  return { id: token.slice(0, dot), raw: token.slice(dot + 1) };
}

// ---- users ---------------------------------------------------------------

export interface UserRecord {
  id: string;
  email: string;
  createdAt: number;
  githubId: string | null;
  githubLogin: string | null;
  avatarUrl: string | null;
}

interface UserRow {
  id: string;
  email: string;
  created_at: number;
  github_id: string | null;
  github_login: string | null;
  avatar_url: string | null;
}

const USER_COLS = `id, email, created_at, github_id, github_login, avatar_url`;

function rowToUser(r: UserRow): UserRecord {
  return { id: r.id, email: r.email, createdAt: r.created_at, githubId: r.github_id, githubLogin: r.github_login, avatarUrl: r.avatar_url };
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const { rows } = await query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const { rows } = await query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function getUserByGithubId(githubId: string): Promise<UserRecord | null> {
  const { rows } = await query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE github_id = $1`, [githubId]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// Resolve a GitHub identity to a user, creating or linking as needed. Open sign-up:
// anyone with GitHub becomes a user; what they can *see* is decided by workspace
// membership, not by an allowlist.
export async function ensureUserFromGithub(profile: GithubProfile): Promise<UserRecord> {
  // Known GitHub identity → refresh the mutable profile fields and return.
  const byGithub = await getUserByGithubId(profile.githubId);
  if (byGithub) {
    await query(`UPDATE users SET github_login = $2, avatar_url = $3, email = $4 WHERE id = $1`, [
      byGithub.id,
      profile.login,
      profile.avatarUrl,
      profile.email,
    ]);
    return { ...byGithub, email: profile.email, githubLogin: profile.login, avatarUrl: profile.avatarUrl };
  }
  // Pre-existing user with this email (e.g. a seeded admin) → link GitHub onto it,
  // so their existing workspaces carry over.
  const byEmail = await getUserByEmail(profile.email);
  if (byEmail) {
    await query(`UPDATE users SET github_id = $2, github_login = $3, avatar_url = $4 WHERE id = $1`, [
      byEmail.id,
      profile.githubId,
      profile.login,
      profile.avatarUrl,
    ]);
    return { ...byEmail, githubId: profile.githubId, githubLogin: profile.login, avatarUrl: profile.avatarUrl };
  }
  // Brand-new user.
  const id = randomUUID();
  await query(`INSERT INTO users (id, email, created_at, github_id, github_login, avatar_url) VALUES ($1, $2, $3, $4, $5, $6)`, [
    id,
    profile.email,
    Date.now(),
    profile.githubId,
    profile.login,
    profile.avatarUrl,
  ]);
  const rec = await getUserByGithubId(profile.githubId);
  if (!rec) throw new Error("ensureUserFromGithub: row vanished after insert");
  return rec;
}

// ---- devices (long-lived tokens) ----------------------------------------

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface DeviceView {
  id: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number;
}

export async function issueDevice(userId: string, label: string | null, client: ClientInfo): Promise<{ token: string; device: DeviceView }> {
  const id = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + config.deviceTokenTtlMs;
  await query(
    `INSERT INTO devices (id, user_id, label, token_hash, created_at, last_seen_at, expires_at, revoked_at, client_ip, client_ua)
     VALUES ($1, $2, $3, $4, $5, $5, $6, NULL, $7, $8)`,
    [id, userId, label, sha256(secret), now, expiresAt, client.ip, client.userAgent],
  );
  return { token: `${id}.${secret}`, device: { id, label, createdAt: now, lastSeenAt: now, expiresAt } };
}

export interface AuthContext {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  deviceId: string;
}

// The single verification used by BOTH the /api/* HTTP middleware and the future
// WebSocket handshake. Null on any failure (unknown/revoked/expired/bad secret) —
// callers turn that into a 401 / close.
export async function verifyDeviceToken(token: string): Promise<AuthContext | null> {
  const parsed = parseCompoundToken(token);
  if (!parsed) return null;
  const { rows } = await query<{
    device_id: string;
    token_hash: string;
    expires_at: number;
    revoked_at: number | null;
    user_id: string;
    email: string;
    github_login: string | null;
    avatar_url: string | null;
  }>(
    `SELECT d.id AS device_id, d.token_hash, d.expires_at, d.revoked_at, u.id AS user_id, u.email, u.github_login, u.avatar_url
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.id = $1`,
    [parsed.id],
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;
  if (!hashesMatch(parsed.raw, row.token_hash)) return null;
  // Throttle last-seen writes to ~hourly — liveness, not an access log.
  const now = Date.now();
  void query(`UPDATE devices SET last_seen_at = $2 WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < $3)`, [
    row.device_id,
    now,
    now - 3_600_000,
  ]).catch(() => undefined);
  return { userId: row.user_id, email: row.email, githubLogin: row.github_login, avatarUrl: row.avatar_url, deviceId: row.device_id };
}

const WEBSOCKET_TICKET_TTL_MS = 30_000;

export async function issueWebSocketTicket(auth: AuthContext): Promise<{ ticket: string; expiresAt: number }> {
  const ticket = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + WEBSOCKET_TICKET_TTL_MS;
  await query(
    `INSERT INTO websocket_tickets (ticket_hash,user_id,device_id,created_at,expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [sha256(ticket), auth.userId, auth.deviceId, now, expiresAt],
  );
  // Opportunistic bounded cleanup; no credential material is stored here.
  void query(`DELETE FROM websocket_tickets WHERE expires_at < $1`, [now]).catch(() => undefined);
  return { ticket, expiresAt };
}

export async function consumeWebSocketTicket(ticket: string): Promise<AuthContext | null> {
  if (!ticket || ticket.length > 128) return null;
  const consumed = await query<{ user_id: string; device_id: string }>(
    `DELETE FROM websocket_tickets WHERE ticket_hash=$1 AND expires_at >= $2 RETURNING user_id,device_id`,
    [sha256(ticket), Date.now()],
  );
  const row = consumed.rows[0];
  if (!row) return null;
  // A device revoked after ticket issuance must still be rejected.
  const active = await query<{ email: string; github_login: string | null; avatar_url: string | null }>(
    `SELECT u.email,u.github_login,u.avatar_url FROM devices d JOIN users u ON u.id=d.user_id
      WHERE d.id=$1 AND d.user_id=$2 AND d.revoked_at IS NULL AND d.expires_at >= $3`,
    [row.device_id, row.user_id, Date.now()],
  );
  const user = active.rows[0];
  return user ? { userId: row.user_id, deviceId: row.device_id, email: user.email, githubLogin: user.github_login, avatarUrl: user.avatar_url } : null;
}

export async function listDevices(userId: string): Promise<DeviceView[]> {
  const { rows } = await query<{
    id: string;
    label: string | null;
    created_at: number;
    last_seen_at: number | null;
    expires_at: number;
    revoked_at: number | null;
  }>(
    `SELECT id, label, created_at, last_seen_at, expires_at, revoked_at
       FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at }));
}

// Scoped to the owning user so one device can only ever revoke its siblings — a lost
// phone is revoked without touching anyone else's access.
export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  const now = Date.now();
  const { rowCount } = await query(`UPDATE devices SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [
    deviceId,
    userId,
    now,
  ]);
  if ((rowCount ?? 0) > 0) {
    // A logged-out or remotely revoked phone must stop receiving private event
    // content even if its OS token remains technically valid.
    await query(`UPDATE push_subscriptions SET disabled_at=$3 WHERE device_id=$1 AND user_id=$2 AND disabled_at IS NULL`, [deviceId, userId, now]);
  }
  return (rowCount ?? 0) > 0;
}
