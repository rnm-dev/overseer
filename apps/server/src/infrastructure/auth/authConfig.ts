// Env → the sign-in methods this instance actually has. Pure: it takes the
// environment as an argument and imports nothing, so config.ts owns the wiring
// without infrastructure and config depending on each other in a cycle, and so
// precedence is testable without touching process.env.
//
// Each door is either configured or absent:
//
//   OVERSEER_GITHUB_CLIENT_ID + OVERSEER_GITHUB_CLIENT_SECRET   GitHub OAuth
//   OVERSEER_PASSWORD_AUTH=1                                     email + password
//   OVERSEER_OIDC_ISSUER + OVERSEER_OIDC_CLIENT_ID/_SECRET       OpenID Connect
//
// A method is represented by its settings or by null — never by a set of flat
// fields a caller has to re-add to decide availability. Half a GitHub app (an
// id with no secret) is null with a warning, not a method that advertises a
// client id the exchange cannot complete.

export type AuthMethodId = "github" | "password" | "oidc";

export interface GithubAuthSettings {
  clientId: string;
  clientSecret: string;
  scope: string;
  // The single frontend HTTPS callback registered with GitHub. Both web and
  // native starts use it; server-backed state decides which client gets the
  // result.
  redirectUri: string;
  // Deep links a native client may be sent back to, allowlisted here so a
  // request cannot name its own.
  nativeCallbacks: string[];
}

export interface OidcAuthSettings {
  // Origin of the provider, without a trailing slash. Everything else about it
  // — endpoints, keys — is discovered from `${issuer}/.well-known/openid-configuration`
  // at first use, so an instance configures who signs in, not where each route is.
  issuer: string;
  clientId: string;
  clientSecret: string;
  // `openid` is added if an operator leaves it out: without it a provider is
  // free to answer with a plain OAuth grant and no identity at all.
  scope: string;
  redirectUri: string;
  nativeCallbacks: string[];
  // What the sign-in button says. Defaults to the issuer's host, which is a
  // better name for a private provider than the word "OIDC".
  label: string;
  // This instance vouches for the issuer's addresses when the issuer will not.
  // Some directories — Entra ID among them — never emit `email_verified` even
  // though no person there can self-assert an address, so the default refusal
  // would reject every one of their operators. Off by default: it is only safe
  // when the issuer owns its addresses, which is a fact about a deployment and
  // not about the protocol.
  trustEmail: boolean;
  // Which claim carries the operator's address. `email` by the specification,
  // but a provider is free not to send it: Entra ID fills `email` from a mailbox
  // an account may not have, while `preferred_username` holds the directory's
  // own name for the person and is always there. Naming the claim is how an
  // instance adapts to its provider instead of making every provider adapt to
  // us — and it is only ever read as an address, so a claim holding something
  // else is refused rather than turned into one.
  emailClaim: string;
  // The workspace every operator who comes through this door joins, by slug, or
  // null for the personal workspace every other door produces. No claim decides
  // it: the issuer is single-tenant and compared byte for byte, so arriving here
  // already means being in that directory.
  joinWorkspace: string | null;
}

export interface AuthConfig {
  // null = this instance has no such door. Availability is this, and only this.
  github: GithubAuthSettings | null;
  oidc: OidcAuthSettings | null;
  password: boolean;
  // How long an issued device token lives — the same token whichever door
  // issued it.
  deviceTokenTtlMs: number;
  warnings: string[];
}

export type AuthMethodAvailability = Record<AuthMethodId, boolean>;

export function authMethodAvailability(auth: AuthConfig): AuthMethodAvailability {
  return { github: auth.github !== null, password: auth.password, oidc: auth.oidc !== null };
}

export function isAuthMethodEnabled(auth: AuthConfig, method: AuthMethodId): boolean {
  return authMethodAvailability(auth)[method];
}

/**
 * What `GET /api/auth/methods` answers, and what the sign-in page renders from.
 *
 * The wire shape is built here rather than in the route, because it is the same
 * decision as availability plus the one thing a client cannot derive: what to
 * call a provider only this instance knows about.
 */
export interface AuthMethodsDescription extends AuthMethodAvailability {
  oidcLabel: string | null;
}

export function describeAuthMethods(auth: AuthConfig): AuthMethodsDescription {
  return { ...authMethodAvailability(auth), oidcLabel: auth.oidc?.label ?? null };
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function csv(env: NodeJS.ProcessEnv, name: string, fallback: string): string[] {
  const raw = trimmed(env, name) || fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = trimmed(env, name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveGithub(
  env: NodeJS.ProcessEnv,
  publicUrl: string,
  warnings: string[],
): GithubAuthSettings | null {
  const clientId = trimmed(env, "OVERSEER_GITHUB_CLIENT_ID");
  const clientSecret = trimmed(env, "OVERSEER_GITHUB_CLIENT_SECRET");
  if (!clientId && !clientSecret) return null;
  // One half of an OAuth app cannot sign anyone in, and a client id handed to
  // the SPA without its secret produces a redirect to GitHub that dead-ends on
  // the exchange. Refuse the whole method and say which half is missing.
  if (!clientId || !clientSecret) {
    warnings.push(
      `OVERSEER_GITHUB_CLIENT_${clientId ? "SECRET" : "ID"} is empty while the other half is set — GitHub sign-in is disabled.`,
    );
    return null;
  }
  return {
    clientId,
    clientSecret,
    scope: trimmed(env, "OVERSEER_GITHUB_SCOPE") || "read:user user:email",
    redirectUri: trimmed(env, "OVERSEER_GITHUB_REDIRECT_URI") || `${publicUrl}/auth/github/callback`,
    nativeCallbacks: csv(env, "OVERSEER_GITHUB_NATIVE_CALLBACKS", "overseer://oauth/github"),
  };
}

// An https origin, or null with a warning. A provider reached over plain http
// could be substituted by anything on the path, and every OIDC guarantee below
// rests on the discovery document being the provider's own.
function issuerOrigin(raw: string, warnings: string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    warnings.push(`OVERSEER_OIDC_ISSUER is not a URL (${raw}) — OIDC sign-in is disabled.`);
    return null;
  }
  if (url.protocol !== "https:") {
    warnings.push(`OVERSEER_OIDC_ISSUER must be https (${raw}) — OIDC sign-in is disabled.`);
    return null;
  }
  // The issuer is compared byte for byte against the `iss` claim later, so it is
  // normalised once, here, rather than at each comparison.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function resolveOidc(
  env: NodeJS.ProcessEnv,
  publicUrl: string,
  warnings: string[],
): OidcAuthSettings | null {
  const rawIssuer = trimmed(env, "OVERSEER_OIDC_ISSUER");
  const clientId = trimmed(env, "OVERSEER_OIDC_CLIENT_ID");
  const clientSecret = trimmed(env, "OVERSEER_OIDC_CLIENT_SECRET");
  if (!rawIssuer && !clientId && !clientSecret) return null;
  const missing = [
    rawIssuer ? "" : "OVERSEER_OIDC_ISSUER",
    clientId ? "" : "OVERSEER_OIDC_CLIENT_ID",
    clientSecret ? "" : "OVERSEER_OIDC_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    warnings.push(`${missing.join(" / ")} ${missing.length > 1 ? "are" : "is"} empty while OIDC is partly configured — OIDC sign-in is disabled.`);
    return null;
  }
  const issuer = issuerOrigin(rawIssuer, warnings);
  if (!issuer) return null;
  const requested = (trimmed(env, "OVERSEER_OIDC_SCOPE") || "openid profile email").split(/\s+/).filter(Boolean);
  const scope = (requested.includes("openid") ? requested : ["openid", ...requested]).join(" ");
  const trustEmail = trimmed(env, "OVERSEER_OIDC_TRUST_EMAIL") === "1";
  const emailClaim = trimmed(env, "OVERSEER_OIDC_EMAIL_CLAIM") || "email";
  // `email_verified` is the provider's word about `email` and about nothing else,
  // so an instance reading the address from elsewhere has to say who vouches for
  // it. Strict plus a custom claim refuses every sign-in, which is a
  // configuration fault worth a name at boot rather than a mystery at the door.
  if (emailClaim !== "email" && !trustEmail) {
    warnings.push(
      `OVERSEER_OIDC_EMAIL_CLAIM is ${emailClaim}, which no email_verified claim describes — set OVERSEER_OIDC_TRUST_EMAIL=1 to vouch for it, or every OIDC sign-in will be refused.`,
    );
  }
  return {
    issuer,
    clientId,
    clientSecret,
    scope,
    redirectUri: trimmed(env, "OVERSEER_OIDC_REDIRECT_URI") || `${publicUrl}/auth/oidc/callback`,
    nativeCallbacks: csv(env, "OVERSEER_OIDC_NATIVE_CALLBACKS", "overseer://oauth/oidc"),
    label: trimmed(env, "OVERSEER_OIDC_LABEL") || new URL(issuer).host,
    trustEmail,
    emailClaim,
    joinWorkspace: trimmed(env, "OVERSEER_OIDC_JOIN_WORKSPACE") || null,
  };
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv, publicUrl: string): AuthConfig {
  const warnings: string[] = [];
  const github = resolveGithub(env, publicUrl, warnings);
  const oidc = resolveOidc(env, publicUrl, warnings);
  // Registration and sign-in share the switch: an instance that does not want
  // local accounts must not accept new ones either.
  const password = trimmed(env, "OVERSEER_PASSWORD_AUTH") === "1";
  if (!github && !password && !oidc) {
    warnings.push(
      "No sign-in method is configured (OVERSEER_GITHUB_CLIENT_ID / OVERSEER_GITHUB_CLIENT_SECRET, OVERSEER_PASSWORD_AUTH, OVERSEER_OIDC_ISSUER) — nobody can log in.",
    );
  }
  return {
    github,
    oidc,
    password,
    deviceTokenTtlMs: positiveNumber(env, "OVERSEER_DEVICE_TOKEN_TTL_MS", 90 * 24 * 60 * 60_000),
    warnings,
  };
}
