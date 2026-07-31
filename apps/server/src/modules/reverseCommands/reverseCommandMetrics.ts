import { isReverseCommandOperation } from "./reverseCommandTypes.js";

export type ReverseCommandMetric =
  | "queued"
  | "accepted"
  | "completed"
  | "replayed"
  | "timeout"
  | "disconnect_before_acceptance"
  | "disconnect_after_acceptance"
  | "error";

const counters = new Map<string, number>();

const SAFE_CODES = new Set([
  "none",
  "OK",
  "BAD_COMMAND",
  "BAD_REQUEST",
  "CAPABILITY_UNAVAILABLE",
  "COMMAND_BACKPRESSURED",
  "COMMAND_EXPIRED",
  "COMMAND_ID_REUSED",
  "COMMAND_LEDGER_FULL",
  "COMMAND_PENDING_LIMIT",
  "COMMAND_SEND_FAILED",
  "COMMAND_TIMEOUT",
  "CONNECTION_LOST",
  "FORBIDDEN",
  "INTERNAL",
  "PEON_OFFLINE",
  "RATE_LIMITED",
  "SESSION_NOT_RUNNING",
  "UNAUTHORIZED",
  "UNKNOWN_OUTCOME",
  "UNKNOWN_PEON",
  "UNKNOWN_PROJECT",
  "UNKNOWN_PROVIDER",
  "UNKNOWN_SESSION",
]);

// Labels deliberately contain only the operation, lifecycle signal, and stable
// error code. User/Peon IDs, payloads, paths, prompts, and credentials never
// enter metric keys.
export function countReverseCommandMetric(
  metric: ReverseCommandMetric,
  operation?: string | null,
  code?: string | null,
): void {
  const safeOperation = operation && isReverseCommandOperation(operation) ? operation : "other";
  const safeCode = code && SAFE_CODES.has(code) ? code : code ? "other" : "none";
  const key = [metric, safeOperation, safeCode].join(":");
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function reverseCommandMetricsSnapshot(): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counters));
}

export function resetReverseCommandMetricsForTest(): void {
  counters.clear();
}
