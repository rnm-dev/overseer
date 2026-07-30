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
