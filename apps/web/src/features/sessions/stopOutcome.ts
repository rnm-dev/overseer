import { ApiError, isPeonNeedsUpdate } from "../../shared/api";

// "already-stopped" is the Peon's 409 SESSION_NOT_RUNNING: the run this page
// still shows as live had already finished, so the refusal is a correction of
// our own state rather than a failure of the command.
export type StopOutcome = "stopped" | "already-stopped" | "unsupported" | "failed";

export function stopOutcome(err: unknown): StopOutcome {
  if (err instanceof ApiError && err.status === 409) return "already-stopped";
  if (isPeonNeedsUpdate(err)) return "unsupported";
  return "failed";
}
