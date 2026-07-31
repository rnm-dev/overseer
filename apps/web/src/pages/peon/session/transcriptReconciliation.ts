import { latestRunSignal, type Ev } from "./parsing";

export const TAIL_FALLBACK_CHECK_MS = 5_000;
export const TAIL_FALLBACK_SILENCE_MS = 30_000;

export interface TranscriptFallbackState {
  now: number;
  running: boolean;
  historyReady: boolean;
  tailUnhealthy: boolean;
  lastTailActivityAt: number | null;
  lastReconcileAt: number | null;
}

export type TranscriptReconcileMode = "none" | "status" | "transcript";

// An authoritative newest page is the strongest statement about a run there is.
// Once its result event is merged into history, the live tail frame repeating
// that event is deduplicated and the "idle" signal it carried is lost with it,
// so the page itself has to end the run — otherwise the working indicator
// outlives the turn until the session is reopened.
export function snapshotEndsRun(running: boolean, events: Ev[]): boolean {
  return running && latestRunSignal(events) === "idle";
}

export function replaceTranscriptRequest(previous: AbortController | null): AbortController {
  previous?.abort();
  return new AbortController();
}

// Silence is normal while an agent is thinking. Check only the tiny session
// record in that case; another full transcript is justified only when the tail
// explicitly failed. If the status check observes completion, the caller also
// takes one final authoritative transcript snapshot.
export function transcriptReconcileMode(state: TranscriptFallbackState): TranscriptReconcileMode {
  if (!state.running || !state.historyReady) return "none";
  if (state.lastReconcileAt !== null && state.now - state.lastReconcileAt < TAIL_FALLBACK_SILENCE_MS) return "none";
  if (state.tailUnhealthy) {
    return "transcript";
  }
  return state.now - (state.lastTailActivityAt ?? 0) >= TAIL_FALLBACK_SILENCE_MS ? "status" : "none";
}
