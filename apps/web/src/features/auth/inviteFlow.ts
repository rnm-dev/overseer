export function loginPathForInvite(token: string | undefined): string {
  return token ? `/login?invite=${encodeURIComponent(token)}` : "/login";
}

export function inviteForLogin(search: string, stored: string | null): string | null {
  return new URLSearchParams(search).get("invite")?.trim() || stored;
}

export function providerStartBody(callback: string | null, invite: string | null): Record<string, string> {
  return {
    ...(callback ? { callback } : {}),
    ...(invite ? { invite } : {}),
  };
}
