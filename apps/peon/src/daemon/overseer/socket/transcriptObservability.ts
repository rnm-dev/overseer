const CAPABILITIES = ["transcript-sync-v1", "other"] as const;
type Capability = typeof CAPABILITIES[number];
type Result = "accepted" | "outbox_full" | "persist_failed" | "invalid";

const admissions = new Map<string, { count: number; totalMs: number; maxMs: number }>();
let pending = Object.freeze({
  "transcript-sync-v1": { count: 0, bytes: 0, oldestAgeMs: 0 },
  other: { count: 0, bytes: 0, oldestAgeMs: 0 },
});

function capability(value: string | undefined): Capability {
  return value === "transcript-sync-v1" ? value : "other";
}

export function observeTranscriptAdmission(input: { capability?: string; elapsedMs: number; result: Result }): void {
  if (capability(input.capability) !== "transcript-sync-v1") return;
  const key = input.result;
  const current = admissions.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
  current.count += 1;
  current.totalMs += Math.max(0, input.elapsedMs);
  current.maxMs = Math.max(current.maxMs, input.elapsedMs);
  admissions.set(key, current);
}

export function observeOutboxPending(messages: readonly {
  capability?: string; payloadBytes: number; createdAt: number;
}[], now = Date.now()): void {
  const next = {
    "transcript-sync-v1": { count: 0, bytes: 0, oldestAgeMs: 0 },
    other: { count: 0, bytes: 0, oldestAgeMs: 0 },
  };
  for (const message of messages) {
    const bucket = next[capability(message.capability)];
    bucket.count += 1;
    bucket.bytes += Math.max(0, message.payloadBytes);
    bucket.oldestAgeMs = Math.max(bucket.oldestAgeMs, Math.max(0, now - message.createdAt));
  }
  pending = Object.freeze(next);
}

export function peonTranscriptObservabilitySnapshot(): object {
  return Object.freeze({ admissions: Object.freeze(Object.fromEntries(admissions)), pending });
}

export function resetPeonTranscriptObservabilityForTest(): void {
  admissions.clear();
  observeOutboxPending([], 0);
}

