import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { query, transaction } from "../../infrastructure/db/index.js";
import { acceptInvite, ensureDefaultWorkspace } from "../workspaces/index.js";
import { SIGNUP_CLOSED, mayCreateAccount } from "./signupPolicy.js";
import { issueDevice } from "./authDevices.js";
import { getUserById } from "./authUsers.js";
import type { ClientInfo, PasswordSignInResult, UserRecord } from "./authTypes.js";

// Email + password sign-in, beside GitHub OAuth. A user row carries at most one
// password; a GitHub-only account has none, and the two link on email — which
// ensureUserFromGithub already does, so registering here and later signing in
// with GitHub lands on the same user.
//
// Hashing is scrypt from node:crypto rather than a new dependency. The cost
// parameters travel inside the stored value, so raising them later still leaves
// every existing hash verifiable.

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const COST = { N: 32_768, r: 8, p: 1 };
const KEY_LENGTH = 32;
// scrypt needs 128 * N * r bytes; Node's 32 MiB default is just under what
// N=32768 asks for, so the budget is stated explicitly.
const MAXMEM = 128 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

export class PasswordAuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  // Deliberately permissive: deliverability is not proven by a regex. This only
  // rejects values that cannot be an address at all.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

export function passwordComplaint(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "password is required";
  if (value.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (value.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (!value.trim()) return "password must not be only whitespace";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...COST, maxmem: MAXMEM });
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (!salt.length || !expected.length) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false; // unusable stored parameters — treat as a failed attempt
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Spend roughly the same work when there is no account (or no password on it),
// so the response time does not answer "does this email exist?".
let decoyHash: Promise<string> | null = null;
async function burnComparableWork(password: string): Promise<void> {
  decoyHash ??= hashPassword(randomBytes(24).toString("base64url"));
  await verifyPassword(password, await decoyHash).catch(() => undefined);
}

async function passwordHashOf(userId: string): Promise<string | null> {
  const { rows } = await query<{ password_hash: string | null }>(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  return rows[0]?.password_hash ?? null;
}

// Addresses are matched case-insensitively here even though the column's unique
// index is not: GitHub supplies an email verbatim, so an older row may carry
// capitals that a person typing the same address would not reproduce.
async function findUserByAddress(email: string): Promise<UserRecord | null> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM users WHERE LOWER(email) = $1 ORDER BY created_at LIMIT 1`, [email]);
  return rows[0] ? await getUserById(rows[0].id) : null;
}

const UNIQUE_VIOLATION = "23505";

async function signIn(user: UserRecord, client: ClientInfo): Promise<PasswordSignInResult> {
  const { token, device } = await issueDevice(user.id, client.userAgent?.slice(0, 80) ?? null, client);
  return { token, user, device };
}

// Proving the credential and issuing the session are separate steps, because
// not every caller wants the second one. A webview sign-in ends at a one-time
// app code, and the device is issued when that code is exchanged — by the app,
// which is the thing that will actually hold it. Issuing one here as well would
// leave a live 90-day credential behind on every native sign-in that nothing
// ever receives.

export async function createAccountWithPassword(input: { email: unknown; password: unknown; invite?: unknown }): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  if (!email) throw new PasswordAuthError(400, "INVALID_EMAIL", "a valid email address is required");
  // Before the password is even judged: on a closed instance an uninvited
  // request should learn nothing about what this one would have accepted.
  if (!(await mayCreateAccount(input.invite))) {
    throw new PasswordAuthError(403, SIGNUP_CLOSED.code, SIGNUP_CLOSED.message);
  }
  const complaint = passwordComplaint(input.password);
  if (complaint) throw new PasswordAuthError(400, "WEAK_PASSWORD", complaint);
  const password = input.password as string;

  const taken = new PasswordAuthError(409, "EMAIL_TAKEN", "an account with this email already exists");
  if (await findUserByAddress(email)) throw taken;

  const hash = await hashPassword(password);
  const id = randomUUID();
  try {
    await query(
      `INSERT INTO users (id, email, created_at, github_id, github_login, avatar_url, password_hash)
       VALUES ($1, $2, $3, NULL, NULL, NULL, $4)`,
      [id, email, Date.now(), hash],
    );
  } catch (err) {
    // A registration that raced the check above loses here instead of creating
    // a second account for one address.
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw taken;
    throw err;
  }

  const user = await getUserById(id);
  if (!user) throw new Error("registerWithPassword: row vanished after insert");
  // The invitation that permitted this account is spent on it, so the person
  // lands in the workspace they were invited to instead of a personal one.
  const invite = typeof input.invite === "string" ? input.invite.trim() : "";
  if (invite) await acceptInvite(invite, user.id);
  await ensureDefaultWorkspace(user.id, user.email);
  return user;
}

export async function registerWithPassword(input: { email: unknown; password: unknown; invite?: unknown; client: ClientInfo }): Promise<PasswordSignInResult> {
  return signIn(await createAccountWithPassword(input), input.client);
}

export async function authenticateWithPassword(input: { email: unknown; password: unknown }): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === "string" ? input.password : "";
  const invalid = new PasswordAuthError(401, "INVALID_CREDENTIALS", "incorrect email or password");
  if (!email || !password || password.length > MAX_PASSWORD_LENGTH) {
    await burnComparableWork(password);
    throw invalid;
  }

  const user = await findUserByAddress(email);
  const hash = user ? await passwordHashOf(user.id) : null;
  if (!user || !hash) {
    // Either no account, or a GitHub-only account with no password set. Both
    // answer the same way — the sign-in page offers GitHub right beside this.
    await burnComparableWork(password);
    throw invalid;
  }
  if (!(await verifyPassword(password, hash))) throw invalid;

  await ensureDefaultWorkspace(user.id, user.email);
  return user;
}

export async function signInWithPassword(input: { email: unknown; password: unknown; client: ClientInfo }): Promise<PasswordSignInResult> {
  return signIn(await authenticateWithPassword(input), input.client);
}

// Break-glass recovery for an operator with shell access to the server, used by
// the set-password CLI. There is no self-service reset yet, so this is how a
// forgotten password on a self-hosted instance gets replaced. It also serves a
// GitHub-only account that never had a password. Every live device of the user
// is revoked in the same transaction: whoever may have held the old password
// should not keep a session minted with it.
export async function resetPasswordByEmail(input: { email: unknown; password: unknown }): Promise<{ user: UserRecord; revokedDevices: number }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new PasswordAuthError(400, "INVALID_EMAIL", "a valid email address is required");
  const complaint = passwordComplaint(input.password);
  if (complaint) throw new PasswordAuthError(400, "WEAK_PASSWORD", complaint);
  const user = await findUserByAddress(email);
  if (!user) throw new PasswordAuthError(404, "UNKNOWN_ACCOUNT", `no account uses ${email}`);

  const hash = await hashPassword(input.password as string);
  const revokedDevices = await transaction(async (tx) => {
    await tx.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user.id, hash]);
    const { rowCount } = await tx.query(`UPDATE devices SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [user.id, Date.now()]);
    return rowCount ?? 0;
  });
  return { user, revokedDevices };
}
