import type { PeonCallResult } from "../peonClient/index.js";

// The Peon answers 409 SESSION_NOT_RUNNING when the session it was asked to
// cancel has no active run.
const SESSION_NOT_RUNNING = 409;

export interface CancelSessionRunDeps {
  cancel: () => Promise<PeonCallResult>;
  snapshot: () => Promise<PeonCallResult>;
  publish: (snapshot: PeonCallResult) => Promise<boolean>;
}

// A cancel that finds nothing running always means the operator was acting on a
// stale "running" state: the run ended while its event push was missed, so the
// index (and every client reading it) still shows the session as live. Treat the
// refusal as the reconciliation trigger it is — pull the Peon's authoritative
// record and republish it, so pressing Stop repairs the view instead of only
// reporting the mismatch. Healing is best-effort: the Peon's answer is relayed
// unchanged either way, and the periodic reconcile remains the backstop.
export async function cancelSessionRun(deps: CancelSessionRunDeps): Promise<PeonCallResult> {
  const result = await deps.cancel();
  if (result.ok || result.status !== SESSION_NOT_RUNNING) return result;
  try {
    await deps.publish(await deps.snapshot());
  } catch {
    // Never turn a healing attempt into a different error than the Peon gave.
  }
  return result;
}
