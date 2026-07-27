import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { query } from "../../db.js";
import { disableLiveActivitiesForDevice } from "../../liveActivity.js";
import type { AuthContext, ClientInfo, DeviceView } from "./authTypes.js";

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

export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  const now = Date.now();
  const { rowCount } = await query(`UPDATE devices SET revoked_at = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [
    deviceId,
    userId,
    now,
  ]);
  if ((rowCount ?? 0) > 0) {
    await query(`UPDATE push_subscriptions SET disabled_at=$3 WHERE device_id=$1 AND user_id=$2 AND disabled_at IS NULL`, [deviceId, userId, now]);
    // The two token families are independent (one addresses the app's
    // notification channel, the other an ActivityKit activity), so revocation
    // has to retire both — and end anything still on screen.
    await disableLiveActivitiesForDevice(userId, deviceId).catch((error) => {
      console.warn("live activity: retiring a revoked device failed:", error instanceof Error ? error.message : String(error));
    });
  }
  return (rowCount ?? 0) > 0;
}
