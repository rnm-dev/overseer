export interface GithubAuthConfig {
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  nativeCallbacks: string[];
}

export interface AuthConfig {
  // A GitHub method is either complete or absent. In particular, a lone
  // client id can never leak into the public SPA config as an available door.
  github: GithubAuthConfig | null;
  password: boolean;
  warnings: string[];
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv, publicUrl: string): AuthConfig {
  const clientId = trimmed(env, "OVERSEER_GITHUB_CLIENT_ID");
  const clientSecret = trimmed(env, "OVERSEER_GITHUB_CLIENT_SECRET");
  const password = trimmed(env, "OVERSEER_PASSWORD_AUTH") === "1";
  const github = clientId && clientSecret
    ? {
        clientId,
        clientSecret,
        scope: trimmed(env, "OVERSEER_GITHUB_SCOPE") || "read:user user:email",
        redirectUri: trimmed(env, "OVERSEER_GITHUB_REDIRECT_URI") || `${publicUrl}/auth/github/callback`,
        nativeCallbacks: (env.OVERSEER_GITHUB_NATIVE_CALLBACKS ?? "overseer://oauth/github")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      }
    : null;

  const warnings: string[] = [];
  if (!github) {
    const noSignIn = password ? "" : " Email/password sign-in is also disabled, so nobody can log in.";
    warnings.push(`OVERSEER_GITHUB_CLIENT_ID / OVERSEER_GITHUB_CLIENT_SECRET are not both set — GitHub sign-in is disabled.${noSignIn}`);
  }

  return { github, password, warnings };
}
