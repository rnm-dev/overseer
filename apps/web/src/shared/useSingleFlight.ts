import { useRef } from "react";

// A synchronous lock for mutations: two click handlers can run before React
// commits the first `submitting` state update. The token also lets a response
// from a previous scope (Peon, package, project) be ignored after `reset()`.
export interface SingleFlight {
  /** Returns a token, or null when another submission is still in flight. */
  begin(): number | null;
  locked(): boolean;
  /** True while `token` is the in-flight submission of the current scope. */
  current(token: number): boolean;
  /** Releases the lock if `token` is still current; returns whether it was. */
  finish(token: number): boolean;
  /** Drops the in-flight submission (scope change / unmount). */
  reset(): void;
}

export function createSingleFlight(): SingleFlight {
  let generation = 0;
  let active = false;
  const current = (token: number) => active && token === generation;
  return {
    begin() {
      if (active) return null;
      active = true;
      return ++generation;
    },
    locked: () => active,
    current,
    finish(token) {
      if (!current(token)) return false;
      active = false;
      return true;
    },
    reset() { generation += 1; active = false; },
  };
}

export function useSingleFlight(): SingleFlight {
  const ref = useRef<SingleFlight | null>(null);
  ref.current ??= createSingleFlight();
  return ref.current;
}
