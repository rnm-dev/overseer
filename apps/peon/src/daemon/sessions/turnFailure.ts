import type { AgentEvent } from "../agents/index.js";

// A logical turn that fails without producing anything is replayed a bounded
// number of times. Two attempts past the original cover the failure this
// exists for — a provider hiccup on the first request of a turn — without
// turning a genuine outage into a loop of identical failures.
export const MAX_TRANSIENT_TURN_RETRIES = 2;

// Spaced so the first replay is fast enough to feel like the turn simply took
// longer, and the second waits out a short provider blip.
export const TRANSIENT_TURN_RETRY_DELAYS_MS = [1_500, 5_000];

// A result event is an untyped Record<string, unknown>; every field is read
// defensively. `errors[]` carries the actual human-readable reason (e.g. "No
// conversation found with session ID: ..." from a --resume against a session
// with nothing persisted) — prefer it over dumping the whole raw event, which
// is technically complete but unreadable.
export function explicitFailureReason(event: AgentEvent): string | null {
  if (Array.isArray(event.errors) && event.errors.length > 0) return event.errors.join("; ");
  if (typeof event.result === "string" && event.result.trim()) return event.result;
  return null;
}

export function resultFailureReason(event: AgentEvent): string {
  return explicitFailureReason(event) ?? JSON.stringify(event);
}

// Checked first: a failure that will fail again identically on a replay. The
// operator has to act on these, and a silent retry only delays telling them.
const PERMANENT_PATTERNS = [
  /\b(400|401|403|404|422)\b/,
  /invalid[ _-]?api[ _-]?key|authentication|unauthorized|forbidden|not logged in|please run .*login/,
  /credit balance|billing|quota|usage limit|rate[ _-]?limit/,
  /no conversation found|session .{0,40}not found|cannot be resumed|unresumable/,
  /max turns|turn limit/,
  /prompt is too long|context .{0,20}(limit|exceed)|too many tokens/,
  /invalid request|invalid model|model .{0,40}not found|unsupported/,
  /permission denied|eacces|enoent/,
];

// A failure the same request can survive on a second attempt: the provider's
// own 5xx/overload responses and transport faults between here and it.
const TRANSIENT_PATTERNS = [
  /\b(408|409|425|500|502|503|504|529)\b/,
  /overloaded|internal server error|service unavailable|bad gateway|gateway timeout/,
  /econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up/,
  /fetch failed|network (error|connection)|connection (error|closed|reset|lost)/,
  /stream (error|disconnected|interrupted)|premature close/,
  /timed out|temporar(y|ily)|try again/,
];

// `hasOutput` is the safety rule, not an optimisation: a turn that already
// spoke or called a tool has side effects in the world, and replaying its
// prompt would repeat them. Only a turn that produced nothing is safe to
// replay, which is also the only case where a retry is invisible to the work.
export function isTransientTurnFailure(input: {
  subtype?: unknown;
  reason: string;
  hasOutput: boolean;
}): boolean {
  if (input.hasOutput) return false;
  const text = `${typeof input.subtype === "string" ? input.subtype : ""} ${input.reason}`.toLowerCase();
  if (PERMANENT_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}
