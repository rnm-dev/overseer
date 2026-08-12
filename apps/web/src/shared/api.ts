// Thin fetch wrapper for the Overseer /api surface. Web authentication rides in
// a same-origin HttpOnly cookie; native clients continue to use bearer tokens.
// The legacy localStorage helpers remain only for the one-release migration.

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
    public requestId?: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers);
  if (opts.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(`/api${path}`, { ...opts, headers, credentials: "same-origin" });
  if (!res.ok) {
    let body: { code?: string; error?: string; message?: string; requestId?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, body?.code ?? "ERROR", body?.error || body?.message || res.statusText || `request failed (${res.status})`, body?.requestId);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// `fetch` cannot report how much of a request body has been sent, so an upload
// that wants a progress bar goes through XHR instead. Everything else — the
// same-origin cookie, the /api prefix, the ApiError shape — stays identical.
export function apiUpload<T = unknown>(path: string, body: Blob, opts: {
  headers?: Record<string, string>;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
} = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", `/api${path}`);
    request.withCredentials = true;
    for (const [name, value] of Object.entries(opts.headers ?? {})) request.setRequestHeader(name, value);

    const parse = () => {
      try {
        return JSON.parse(request.responseText) as { code?: string; error?: string; message?: string; requestId?: string };
      } catch {
        return null;
      }
    };
    const abort = () => request.abort();
    opts.signal?.addEventListener("abort", abort);
    const done = () => opts.signal?.removeEventListener("abort", abort);

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) opts.onProgress?.(event.loaded, event.total);
    });
    request.addEventListener("load", () => {
      done();
      const failure = parse();
      if (request.status < 200 || request.status >= 300) {
        return reject(new ApiError(request.status, failure?.code ?? "ERROR", failure?.error || failure?.message || request.statusText || `request failed (${request.status})`, failure?.requestId));
      }
      resolve((failure ?? undefined) as T);
    });
    request.addEventListener("error", () => {
      done();
      reject(new ApiError(0, "NETWORK", "the upload could not reach the server"));
    });
    request.addEventListener("abort", () => {
      done();
      reject(new ApiError(0, "ABORTED", "the upload was cancelled"));
    });
    request.send(body);
  });
}

export async function migrateLegacyWebSession(token: string): Promise<void> {
  const res = await fetch("/api/auth/web-session", {
    method: "POST",
    credentials: "same-origin",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new ApiError(res.status, "WEB_SESSION_MIGRATION_FAILED", "Could not migrate the existing web session");
}

export const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

// A proxied peon endpoint that 404s = the peon predates it (older build). Callers
// show a "peon needs update" note instead of a raw error. (A 503 AGENT_API_DISABLED
// is different — the peon's agent API is switched off, surfaced as a normal error.)
export const isPeonNeedsUpdate = (err: unknown): boolean => err instanceof ApiError && err.status === 404;
