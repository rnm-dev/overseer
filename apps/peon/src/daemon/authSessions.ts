import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./xdgPaths.js";

const STATE_PATH = path.join(configDir(), "authSessions.json");

export const AUTH_SESSION_COOKIE = "aca_dash_session";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days, unchanged from the old shared-password cookie
const LINK_TTL_MS = 15 * 60_000; // the *link* itself is short-lived; the session it becomes is not

export type AuthSessionStatus = "pending" | "active" | "revoked";

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

// One record for the whole lifecycle: pending (link minted, not yet clicked)
// -> active (clicked, now a live session) -> revoked (logout or `peon user
// revoke`). The id stays the same throughout; only status + the two secret
// hashes change.
export interface AuthSessionRecord {
  id: string;
  username: string;
  status: AuthSessionStatus;
  linkTokenHash: string;
  sessionTokenHash: string | null;
  createdAt: number;
  linkExpiresAt: number;
  consumedAt: number | null;
  sessionExpiresAt: number | null;
  revokedAt: number | null;
  client: ClientInfo | null;
  lastSeenAt: number | null;
}

export type PublicAuthSessionRecord = Omit<AuthSessionRecord, "linkTokenHash" | "sessionTokenHash">;

export function stripSecrets(record: AuthSessionRecord): PublicAuthSessionRecord {
  const { linkTokenHash: _linkTokenHash, sessionTokenHash: _sessionTokenHash, ...rest } = record;
  return rest;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Compound token format "id.rawSecret": the id is a plain (non-secret)
// lookup key, so verification is one get(id) + one hash+timingSafeEqual
// compare rather than a scan over every record.
function parseCompoundToken(token: string): { id: string; raw: string } | null {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  return { id: token.slice(0, dot), raw: token.slice(dot + 1) };
}

function hashesMatch(raw: string, storedHex: string): boolean {
  const candidate = Buffer.from(sha256(raw), "hex");
  const actual = Buffer.from(storedHex, "hex");
  return candidate.length === actual.length && timingSafeEqual(candidate, actual);
}

function read(): Record<string, AuthSessionRecord> {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

class AuthSessionStore extends EventEmitter {
  private sessions: Record<string, AuthSessionRecord>;

  constructor() {
    super();
    this.sessions = read();
  }

  private persist(): void {
    mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(this.sessions, null, 2), { mode: 0o600 });
  }

  list(): AuthSessionRecord[] {
    return Object.values(this.sessions);
  }

  listByUsername(username: string): AuthSessionRecord[] {
    return this.list().filter((s) => s.username === username);
  }

  get(id: string): AuthSessionRecord | undefined {
    return this.sessions[id];
  }

  // Mints a fresh pending record. Returns the raw link token exactly once —
  // it is never persisted or retrievable again, only its sha256 is stored.
  issueLink(username: string): { record: AuthSessionRecord; rawLinkToken: string } {
    const rawLinkToken = randomBytes(32).toString("hex");
    const now = Date.now();
    const record: AuthSessionRecord = {
      id: randomUUID(),
      username,
      status: "pending",
      linkTokenHash: sha256(rawLinkToken),
      sessionTokenHash: null,
      createdAt: now,
      linkExpiresAt: now + LINK_TTL_MS,
      consumedAt: null,
      sessionExpiresAt: null,
      revokedAt: null,
      client: null,
      lastSeenAt: null,
    };
    this.sessions[record.id] = record;
    this.persist();
    this.emit("change", record);
    return { record, rawLinkToken };
  }

  // Single-use: only succeeds once, while status is still "pending" and the
  // link hasn't expired. Mints a brand-new, independent session secret rather
  // than reusing the link token, since the link token may end up in browser
  // history/referrer headers/server logs.
  consumeLink(
    compoundToken: string,
    client: ClientInfo,
  ): { record: AuthSessionRecord; rawSessionToken: string } | null {
    const parsed = parseCompoundToken(compoundToken);
    if (!parsed) return null;
    const record = this.sessions[parsed.id];
    if (!record || record.status !== "pending") return null;
    if (record.linkExpiresAt < Date.now()) return null;
    if (!hashesMatch(parsed.raw, record.linkTokenHash)) return null;

    const rawSessionToken = randomBytes(32).toString("hex");
    const now = Date.now();
    const updated: AuthSessionRecord = {
      ...record,
      status: "active",
      sessionTokenHash: sha256(rawSessionToken),
      consumedAt: now,
      sessionExpiresAt: now + SESSION_MAX_AGE_SEC * 1000,
      client,
      lastSeenAt: now,
    };
    this.sessions[record.id] = updated;
    this.persist();
    this.emit("change", updated);
    return { record: updated, rawSessionToken };
  }

  verifySessionToken(compoundToken: string): AuthSessionRecord | null {
    const parsed = parseCompoundToken(compoundToken);
    if (!parsed) return null;
    const record = this.sessions[parsed.id];
    if (!record || record.status !== "active" || !record.sessionTokenHash) return null;
    if (!record.sessionExpiresAt || record.sessionExpiresAt < Date.now()) return null;
    if (!hashesMatch(parsed.raw, record.sessionTokenHash)) return null;
    return record;
  }

  shouldRenew(record: AuthSessionRecord): boolean {
    if (!record.sessionExpiresAt) return false;
    return record.sessionExpiresAt - Date.now() < (SESSION_MAX_AGE_SEC * 1000) / 2;
  }

  // The cookie's own token value never needs to change on renewal (unlike the
  // old self-describing HMAC token) since the expiry lives server-side now —
  // only the record's sessionExpiresAt/lastSeenAt/client move forward.
  renew(record: AuthSessionRecord, client: ClientInfo): void {
    const now = Date.now();
    const updated: AuthSessionRecord = {
      ...record,
      sessionExpiresAt: now + SESSION_MAX_AGE_SEC * 1000,
      lastSeenAt: now,
      client,
    };
    this.sessions[record.id] = updated;
    this.persist();
    this.emit("change", updated);
  }

  revoke(id: string): boolean {
    const record = this.sessions[id];
    if (!record || record.status === "revoked") return false;
    const updated: AuthSessionRecord = { ...record, status: "revoked", revokedAt: Date.now() };
    this.sessions[id] = updated;
    this.persist();
    this.emit("change", updated);
    return true;
  }

  revokeAllForUser(username: string): number {
    const now = Date.now();
    let count = 0;
    for (const record of Object.values(this.sessions)) {
      if (record.username !== username || record.status === "revoked") continue;
      this.sessions[record.id] = { ...record, status: "revoked", revokedAt: now };
      count += 1;
    }
    if (count > 0) {
      this.persist();
      this.emit("change");
    }
    return count;
  }
}

export const authSessions = new AuthSessionStore();
