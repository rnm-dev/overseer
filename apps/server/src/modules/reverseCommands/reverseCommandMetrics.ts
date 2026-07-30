export type ReverseCommandMetric =
  | "queued"
  | "accepted"
  | "completed"
  | "replayed"
  | "timeout"
  | "disconnect_before_acceptance"
  | "disconnect_after_acceptance"
  | "error";

const counters = new Map<string, number>();

// Labels deliberately contain only the operation, lifecycle signal, and stable
// error code. User/Peon IDs, payloads, paths, prompts, and credentials never
// enter metric keys.
export function countReverseCommandMetric(
  metric: ReverseCommandMetric,
  operation?: string | null,
  code?: string | null,
): void {
  const key = [metric, operation ?? "none", code ?? "none"].join(":");
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function reverseCommandMetricsSnapshot(): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counters));
}

export function resetReverseCommandMetricsForTest(): void {
  counters.clear();
}
