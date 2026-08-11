import { query } from "../../infrastructure/db/index.js";
import { randomUUID } from "node:crypto";
import type { GithubProfile } from "../../infrastructure/github/index.js";
import type { OidcIdentity } from "../../infrastructure/oidc/index.js";
import type { UserRecord } from "./authTypes.js";

/**
 * An identity was proved, and it still may not have this account.
 *
 * Distinct from a provider's protocol errors: nothing went wrong on the wire,
 * and the same rules would apply to any door. Whoever translates it to a
 * transport decides the status; every case here is the caller's situation, not
 * a server fault.
 */
export class AccountLinkError extends Error {
  constructor(
    public code: "EMAIL_UNVERIFIED" | "IDENTITY_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

interface UserRow {
  id: string;
  email: string;
  created_at: number;
  github_id: string | null;
  github_login: string | null;
  avatar_url: string | null;
  oidc_issuer: string | null;
  oidc_subject: string | null;
}

const USER_COLS = `id, email, created_at, github_id, github_login, avatar_url, oidc_issuer, oidc_subject`;

function rowToUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    email: r.email,
    createdAt: r.created_at,
    githubId: r.github_id,
    githubLogin: r.github_login,
    avatarUrl: r.avatar_url,
    oidcIssuer: r.oidc_issuer,
    oidcSubject: r.oidc_subject,
  };
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

export async function ensureUserFromGithub(profile: GithubProfile): Promise<UserRecord> {
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

export async function getUserByOidcIdentity(issuer: string, subject: string): Promise<UserRecord | null> {
  const { rows } = await query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2`,
    [issuer, subject],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

/**
 * The account an OIDC identity belongs to, creating or linking it as needed.
 *
 * Identity is (issuer, subject) — the subject is what the provider promises is
 * stable, while an address can be reassigned. Email is only how an OIDC identity
 * *meets* an account that already exists under another door, exactly as GitHub
 * does, and that is why an unverified address is refused here rather than
 * trusted: an instance whose provider lets a person claim any address would
 * otherwise let them claim an existing operator's account with it.
 */
export async function ensureUserFromOidc(identity: OidcIdentity): Promise<UserRecord> {
  if (!identity.emailVerified) {
    throw new AccountLinkError("EMAIL_UNVERIFIED", "the provider has not verified this email address");
  }
  const byIdentity = await getUserByOidcIdentity(identity.issuer, identity.subject);
  if (byIdentity) {
    await query(`UPDATE users SET email = $2, avatar_url = COALESCE($3, avatar_url) WHERE id = $1`, [
      byIdentity.id,
      identity.email,
      identity.avatarUrl,
    ]);
    return { ...byIdentity, email: identity.email, avatarUrl: identity.avatarUrl ?? byIdentity.avatarUrl };
  }

  const byEmail = await getUserByEmail(identity.email);
  if (byEmail) {
    // One account can hold one OIDC identity. A second subject arriving on the
    // same address is a different person at the provider, or the same person
    // after a re-registration; either way, silently re-pointing the account is
    // how one operator ends up signed in as another.
    if (byEmail.oidcSubject && byEmail.oidcSubject !== identity.subject) {
      throw new AccountLinkError("IDENTITY_CONFLICT", "this address is already linked to a different provider identity");
    }
    await query(`UPDATE users SET oidc_issuer = $2, oidc_subject = $3, avatar_url = COALESCE(avatar_url, $4) WHERE id = $1`, [
      byEmail.id,
      identity.issuer,
      identity.subject,
      identity.avatarUrl,
    ]);
    return { ...byEmail, oidcIssuer: identity.issuer, oidcSubject: identity.subject, avatarUrl: byEmail.avatarUrl ?? identity.avatarUrl };
  }

  const id = randomUUID();
  await query(
    `INSERT INTO users (id, email, created_at, avatar_url, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, identity.email, Date.now(), identity.avatarUrl, identity.issuer, identity.subject],
  );
  const created = await getUserByOidcIdentity(identity.issuer, identity.subject);
  if (!created) throw new Error("ensureUserFromOidc: row vanished after insert");
  return created;
}
