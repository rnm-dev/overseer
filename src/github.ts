import { config } from "./config.js";

// GitHub OAuth identity exchange. GitHub returns every client flow to the same
// frontend HTTPS callback, which submits the authorization code to the API. The
// client secret and code exchange remain server-side.
// author: Viktor

export interface GithubProfile {
  githubId: string;
  login: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export class GithubAuthError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function ghToken(code: string, redirectUri: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new GithubAuthError("EXCHANGE_FAILED", `github token endpoint returned ${res.status}`);
  const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (body.error || !body.access_token) {
    // A reused/expired code lands here — surface it as a clean bad-request.
    throw new GithubAuthError("BAD_CODE", body.error_description || body.error || "no access token returned");
  }
  return body.access_token;
}

async function ghGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "overseer" },
  });
  if (!res.ok) throw new GithubAuthError("GITHUB_API", `github ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

// The user's primary, verified email. GitHub omits it from /user when the user
// keeps it private, so fall back to /user/emails (needs the user:email scope). If
// there's genuinely none, synthesize the GitHub noreply address so a user row can
// still be keyed by a stable email.
async function resolveEmail(user: { id: number; login: string; email: string | null }, accessToken: string): Promise<string> {
  if (user.email) return user.email.toLowerCase();
  const emails = await ghGet<{ email: string; primary: boolean; verified: boolean }[]>("/user/emails", accessToken).catch(() => []);
  const pick = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) ?? emails[0];
  if (pick?.email) return pick.email.toLowerCase();
  return `${user.id}+${user.login}@users.noreply.github.com`;
}

// Exchange an OAuth code for the signed-in GitHub identity.
export async function exchangeCodeForProfile(code: string, redirectUri = config.githubRedirectUri): Promise<GithubProfile> {
  const accessToken = await ghToken(code, redirectUri);
  const user = await ghGet<{ id: number; login: string; email: string | null; name: string | null; avatar_url: string | null }>("/user", accessToken);
  const email = await resolveEmail(user, accessToken);
  return {
    githubId: String(user.id),
    login: user.login,
    email,
    name: user.name,
    avatarUrl: user.avatar_url,
  };
}
