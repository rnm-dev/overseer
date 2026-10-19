// The page's belief about whether its session has a run in flight, keyed to the
// session so navigating between routes can never flash the previous session's
// indicator. Every transition is a pure function of the previous state.

export interface ActiveRun {
  sessionKey: string;
  running: boolean;
  model: string | null;
  reasoningEffort: string | null;
  /** Set while the run is only assumed from the indexed summary. */
  assumedAt: number | null;
}

export type ActiveRunAction =
  /** A live signal or authoritative record turned the run on or off. */
  | { type: "set-running"; sessionKey: string; running: boolean }
  /** The model/effort of the current turn; they always travel together. */
  | { type: "set-selection"; sessionKey: string; model: string | null; reasoningEffort: string | null }
  /** The indexed summary says running and nothing newer has spoken. */
  | { type: "seed-indexed"; sessionKey: string; now: number }
  /** The transcript snapshot implies a run. */
  | { type: "snapshot-running"; sessionKey: string }
  /** An indexed assumption expired or its confirmation failed. */
  | { type: "retire-assumed"; sessionKey: string };

export function initialActiveRun(sessionKey: string, indexedStatus: string | null | undefined, now: number): ActiveRun {
  const running = indexedStatus === "running";
  return { sessionKey, running, model: null, reasoningEffort: null, assumedAt: running ? now : null };
}

export function activeRunReducer(previous: ActiveRun, action: ActiveRunAction): ActiveRun {
  const same = previous.sessionKey === action.sessionKey;
  switch (action.type) {
    case "set-running":
      return {
        sessionKey: action.sessionKey,
        running: action.running,
        model: action.running && same ? previous.model : null,
        reasoningEffort: action.running && same ? previous.reasoningEffort : null,
        assumedAt: null,
      };
    case "set-selection":
      return {
        sessionKey: action.sessionKey,
        running: same && previous.running,
        model: action.model,
        reasoningEffort: action.reasoningEffort,
        assumedAt: same ? previous.assumedAt : null,
      };
    case "seed-indexed":
      return same && previous.running
        ? previous
        : { sessionKey: action.sessionKey, running: true, model: null, reasoningEffort: null, assumedAt: action.now };
    case "snapshot-running":
      return {
        sessionKey: action.sessionKey,
        running: true,
        model: same ? previous.model : null,
        reasoningEffort: same ? previous.reasoningEffort : null,
        assumedAt: same ? previous.assumedAt : null,
      };
    case "retire-assumed":
      return same && previous.assumedAt !== null
        ? { ...previous, running: false, model: null, reasoningEffort: null, assumedAt: null }
        : previous;
  }
}
