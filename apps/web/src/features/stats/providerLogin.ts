import type { Provider } from "./statsModel";

// The two agent drivers own their own login APIs (docs/agent-provider-login.md):
// Claude prints an authorization URL and then waits for a pasted code, Codex
// prints a verification URL plus a short user code and polls the provider
// itself. One attempt shape carries both; a field the provider never sets stays
// null rather than becoming a second model to reason about.
export type LoginStatus =
  | "starting"
  | "awaiting_code"
  | "verifying"
  | "waiting_for_authorization"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface LoginAttempt {
  id: string;
  status: LoginStatus;
  authorizationUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number | null;
  pollAfterMs: number;
  error: string | null;
}

const PENDING: LoginStatus[] = ["starting", "awaiting_code", "verifying", "waiting_for_authorization"];
const STATUSES: LoginStatus[] = [...PENDING, "succeeded", "failed", "cancelled", "expired"];

export function loginPending(attempt: LoginAttempt | null): boolean {
  return Boolean(attempt && PENDING.includes(attempt.status));
}

export function loginPath(base: string, provider: Provider): string {
  return `${base}/driver/${provider}/login`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

// Only https/http URLs are ever handed to the operator as a link — a peon is
// trusted, but a rendered `javascript:` href would not be worth the doubt.
function url(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function normalizeAttempt(raw: unknown): LoginAttempt | null {
  const value = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : null;
  // GET /login answers `{attempt: ... | null}`; POST answers the attempt itself.
  if (value && "attempt" in value) return normalizeAttempt(value.attempt);
  const id = value ? text(value.id) : null;
  const status = value?.status;
  if (!id || typeof status !== "string" || !STATUSES.includes(status as LoginStatus)) return null;
  return {
    id,
    status: status as LoginStatus,
    authorizationUrl: url(value?.authorizationUrl),
    verificationUrl: url(value?.verificationUrl),
    userCode: text(value?.userCode),
    expiresAt: typeof value?.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : null,
    pollAfterMs: typeof value?.pollAfterMs === "number" && Number.isFinite(value.pollAfterMs) ? value.pollAfterMs : 0,
    error: text(value?.error),
  };
}

// Peon's own cadence wins, bounded so a peon that answers 0 or a nonsense value
// can neither spin the browser nor stall the flow.
export function pollDelay(attempt: LoginAttempt | null): number {
  const requested = attempt?.pollAfterMs ?? 0;
  return Math.min(10_000, Math.max(1_000, requested > 0 ? requested : 1_500));
}

// Mirrors Peon's own INVALID_LOGIN_CODE guard so a typo is refused locally
// instead of costing a round trip and a 400.
export function loginCodeAccepted(code: string): boolean {
  return /^[A-Za-z0-9_.~#%+/=-]{1,4096}$/.test(code.trim());
}

// A quota probe that failed because the CLI has no usable credentials is not a
// broken card, it is a signed-out account — the one error the operator can fix
// from here. Everything else stays a plain error.
const SIGNED_OUT = /please run \/login|run [`'"]?claude auth login|authentication[_ -]?(?:failed|required)|(?:credential|token|session)(?:[_ -]| has | is )?expired|\b401\b|unauthoriz|unauthenticat|not (?:logged|signed) in|please (?:log|sign) in|re-?authenticat|log ?in again|expired (?:credential|token|session)|invalid[_ -]?(?:api[_ -]?key|token)|no (?:credentials|api key)/i;

export function signedOut(message: string | null | undefined): boolean {
  return Boolean(message && SIGNED_OUT.test(message));
}
