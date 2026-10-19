import { useSyncExternalStore } from "react";

type Clock = { now: number; listeners: Set<() => void>; id?: number };
const clocks = new Map<number, Clock>();

function clockFor(period: number): Clock {
  let clock = clocks.get(period);
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set() };
    clocks.set(period, clock);
  }
  return clock;
}

// One shared interval per period, running only while someone is subscribed.
export function useNow(period: number): number {
  const clock = clockFor(period);
  return useSyncExternalStore(
    (listener) => {
      clock.listeners.add(listener);
      if (clock.id === undefined) {
        clock.now = Date.now();
        clock.id = window.setInterval(() => {
          clock.now = Date.now();
          clock.listeners.forEach((l) => l());
        }, period);
      }
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0 && clock.id !== undefined) {
          window.clearInterval(clock.id);
          clock.id = undefined;
        }
      };
    },
    () => clock.now,
  );
}
