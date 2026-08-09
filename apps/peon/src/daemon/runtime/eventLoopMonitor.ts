import { monitorEventLoopDelay } from "node:perf_hooks";

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();

const milliseconds = (nanoseconds: number): number =>
  Number.isFinite(nanoseconds) ? Math.round((nanoseconds / 1e6) * 10) / 10 : 0;

export function eventLoopDelayStats(): { p95Ms: number; maxMs: number } {
  return {
    p95Ms: milliseconds(delay.percentile(95)),
    maxMs: milliseconds(delay.max),
  };
}
