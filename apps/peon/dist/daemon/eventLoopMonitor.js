import { monitorEventLoopDelay } from "node:perf_hooks";
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const milliseconds = (nanoseconds) => Number.isFinite(nanoseconds) ? Math.round((nanoseconds / 1e6) * 10) / 10 : 0;
export function eventLoopDelayStats() {
    return {
        p95Ms: milliseconds(delay.percentile(95)),
        maxMs: milliseconds(delay.max),
    };
}
