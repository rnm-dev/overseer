import { latestRunSignal, type Ev } from "./parsing";

export const TAIL_FALLBACK_CHECK_MS = 5_000;
export const TAIL_FALLBACK_SILENCE_MS = 30_000;

export interface TranscriptFallbackState {
  now: number;
  running: boolean;
  historyReady: boolean;
  tailUnhealthy: boolean;
  lastReconcileAt: number | null;
}

export type TranscriptReconcileMode = "none" | "transcript";

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

export async function reconcileQueueAtTurnEnd(reconcile: () => Promise<void>, finish: () => void): Promise<void> {
  await reconcile();
  finish();
}

export function transportGapRecoveryDue(now: number, lastRecoveryAt: number | null): boolean {
  return lastRecoveryAt === null || now - lastRecoveryAt >= TAIL_FALLBACK_SILENCE_MS;
}

export function tailUnhealthyAfterFrame(event: string | null): boolean {
  return event === "tailEnd" || event === "tailError";
}

// Silence is normal while an agent is thinking. A healthy live transport is
// therefore never a reason to read either session metadata or the transcript.
// Only an explicit tail failure opens the bounded HTTP recovery path.
export function transcriptReconcileMode(state: TranscriptFallbackState): TranscriptReconcileMode {
  if (!state.running || !state.historyReady) return "none";
  if (state.lastReconcileAt !== null && state.now - state.lastReconcileAt < TAIL_FALLBACK_SILENCE_MS) return "none";
  return state.tailUnhealthy ? "transcript" : "none";
}
