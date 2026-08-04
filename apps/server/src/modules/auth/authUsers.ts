import { query } from "../../infrastructure/db/index.js";
import { randomUUID } from "node:crypto";
import type { GithubProfile } from "../../infrastructure/github/index.js";
import type { UserRecord } from "./authTypes.js";

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
