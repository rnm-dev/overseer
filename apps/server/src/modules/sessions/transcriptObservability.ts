const RESULTS = new Set(["success", "timeout", "cancelled", "protocol_error"]);
const EVENTS = new Set([
  "sequence_gap", "epoch_change", "resync", "replay_mismatch", "eviction",
  "rebuild", "slow_client_disconnect", "recovery_complete",
]);
const DURATION_BUCKETS_MS = [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

const counters = new Map<string, number>();
const durations = new Map<string, {
  count: number;
  totalMs: number;
  maxMs: number;
  buckets: number[];
}>();
let demand: Readonly<{ sessions: number; consumers: number; sharedConsumers: number }> =
  Object.freeze({ sessions: 0, consumers: 0, sharedConsumers: 0 });

export function observeTranscriptEvent(event: string): void {
  const key = EVENTS.has(event) ? event : "other";
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function observeTranscriptDuration(stage: "delivery_commit_ack" | "snapshot" | "catchup", result: string, elapsedMs: number): void {
  const key = `${stage}:${RESULTS.has(result) ? result : "protocol_error"}`;
  const current = durations.get(key) ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: Array.from({ length: DURATION_BUCKETS_MS.length + 1 }, () => 0),
  };
  const boundedElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  current.count += 1;
  current.totalMs += boundedElapsed;
  current.maxMs = Math.max(current.maxMs, boundedElapsed);
  const bucket = DURATION_BUCKETS_MS.findIndex((limit) => boundedElapsed <= limit);
  current.buckets[bucket < 0 ? DURATION_BUCKETS_MS.length : bucket] += 1;
  durations.set(key, current);
}

export function observeTranscriptDemand(values: Iterable<number>): void {
  let sessions = 0; let consumers = 0; let sharedConsumers = 0;
  for (const count of values) {
    sessions += 1; consumers += count; sharedConsumers += Math.max(0, count - 1);
  }
  demand = Object.freeze({ sessions, consumers, sharedConsumers });
}

export function transcriptObservabilitySnapshot(): object {
  const durationSnapshot = Object.fromEntries([...durations].map(([key, value]) => [key, Object.freeze({
    count: value.count,
    totalMs: value.totalMs,
    maxMs: value.maxMs,
    buckets: Object.freeze(Object.fromEntries([
      ...DURATION_BUCKETS_MS.map((limit, index) => [`le_${limit}`, value.buckets[index]]),
      ["overflow", value.buckets[DURATION_BUCKETS_MS.length]],
    ])),
  })]));
  return Object.freeze({
    counters: Object.freeze(Object.fromEntries(counters)),
    durations: Object.freeze(durationSnapshot),
    demand,
  });
}

export function resetTranscriptObservabilityForTest(): void {
  counters.clear(); durations.clear(); observeTranscriptDemand([]);
}
