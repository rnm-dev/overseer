export interface SubmissionToken {
  scope: string;
  id: symbol;
}

/**
 * React state is not a lock: two submit events can run before `setSending(true)`
 * causes a render. This tiny synchronous gate is the actual one-in-flight guard.
 * A new session scope supersedes an old request so route changes never leave the
 * next composer blocked by work that belongs to the previous page.
 */
export function createSubmissionGate() {
  let active: SubmissionToken | null = null;

  return {
    begin(scope: string): SubmissionToken | null {
      if (active?.scope === scope) return null;
      active = { scope, id: Symbol(scope) };
      return active;
    },

    finish(token: SubmissionToken): boolean {
      if (active !== token) return false;
      active = null;
      return true;
    },
  };
}
