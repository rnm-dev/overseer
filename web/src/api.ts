// Thin fetch wrapper for the overseer /api surface. The web app is served
// same-origin, so calls are relative ("/api/...") — no base URL, no CORS. The
// device token (minted by the GitHub sign-in flow) rides as a bearer.

const TOKEN_KEY = "overseer_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (!res.ok) {
    let body: { code?: string; error?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, body?.code ?? "ERROR", body?.error || res.statusText || `request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// A proxied peon endpoint that 404s = the peon predates it (older build). Callers
// show a "peon needs update" note instead of a raw error. (A 503 AGENT_API_DISABLED
// is different — the peon's agent API is switched off, surfaced as a normal error.)
export const isPeonNeedsUpdate = (err: unknown): boolean => err instanceof ApiError && err.status === 404;
