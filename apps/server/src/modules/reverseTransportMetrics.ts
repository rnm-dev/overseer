const KNOWN_CAPABILITIES = new Set([
  "durable-delivery-v1",
  "session-catalog-v1",
  "project-catalog-v1",
  "folder-listing-v1",
  "entry-metadata-v1",
  "reverse-command-v1",
  "transcript-sync-v1",
  "runtime-state-v1",
  "daemon-configuration-v1",
  "project-file-read-v1",
  "sandbox-file-read-v1",
  "file-write-v1",
  "session-artifact-v1",
]);

type SocketPlane = "control" | "transfer";

const counters = new Map<string, number>();

function increment(parts: readonly string[]): void {
  const key = parts.join(":");
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

export function observeNegotiatedConnection(input: {
  plane: SocketPlane;
  replacement: boolean;
  capabilities: readonly string[];
}): void {
  increment(["connection", input.plane, input.replacement ? "replacement" : "initial"]);
  const accepted = new Set(input.capabilities);
  for (const capability of KNOWN_CAPABILITIES) {
    if (accepted.has(capability)) increment(["negotiated", input.plane, capability]);
  }
  if ([...accepted].some((capability) => !KNOWN_CAPABILITIES.has(capability))) {
    increment(["negotiated", input.plane, "other"]);
  }
}

export function reverseTransportMetricsSnapshot(): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(counters));
}

export function resetReverseTransportMetricsForTest(): void {
  counters.clear();
}
