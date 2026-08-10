const RESULTS = new Set(["success", "timeout", "cancelled", "protocol_error"]);
const STAGES = new Set(["client_apply", "project_apply", "peon_apply", "snapshot", "reconnect"]);
const EVENTS = new Set(["gap", "epoch_change", "rebuild", "stale_generation", "replay_mismatch", "slow_client_disconnect"]);
const BUCKETS_MS = [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

const counters = new Map<string, number>();
const durations = new Map<string, { count: number; totalMs: number; maxMs: number; buckets: number[] }>();

export function observeResourceSyncEvent(event: string): void {
  const key = EVENTS.has(event) ? event : "other";
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function observeResourceSyncDuration(stage: string, result: string, elapsedMs: number): void {
  const key = `${STAGES.has(stage) ? stage : "other"}:${RESULTS.has(result) ? result : "protocol_error"}`;
  const current = durations.get(key) ?? { count: 0, totalMs: 0, maxMs: 0, buckets: Array(BUCKETS_MS.length + 1).fill(0) };
  const bounded = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  current.count += 1;
  current.totalMs += bounded;
  current.maxMs = Math.max(current.maxMs, bounded);
  const index = BUCKETS_MS.findIndex((limit) => bounded <= limit);
  current.buckets[index < 0 ? BUCKETS_MS.length : index] += 1;
  durations.set(key, current);
}

export function resourceSyncObservabilitySnapshot(): object {
  return Object.freeze({
    counters: Object.freeze(Object.fromEntries(counters)),
    durations: Object.freeze(Object.fromEntries([...durations].map(([key, value]) => [key, Object.freeze({
      count: value.count,
      totalMs: value.totalMs,
      maxMs: value.maxMs,
      buckets: Object.freeze(Object.fromEntries([
        ...BUCKETS_MS.map((limit, index) => [`le_${limit}`, value.buckets[index]]),
        ["overflow", value.buckets[BUCKETS_MS.length]],
      ])),
    })]))),
  });
}

export function resetResourceSyncObservabilityForTest(): void {
  counters.clear();
  durations.clear();
}
