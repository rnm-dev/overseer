export const INDEXED_RUN_ASSUMPTION_TTL_MS = 10_000;

export function shouldSeedIndexedRun({
  indexedStatus,
  metadataStatusKnown,
  runRevision,
  refuted,
}: {
  indexedStatus: string | null | undefined;
  metadataStatusKnown: boolean;
  runRevision: number;
  refuted: boolean;
}): boolean {
  return indexedStatus === "running" && !metadataStatusKnown && runRevision === 0 && !refuted;
}

export function indexedRunAssumptionDelay(now: number, assumedAt: number | null): number | null {
  if (assumedAt === null) return null;
  return Math.max(0, INDEXED_RUN_ASSUMPTION_TTL_MS - (now - assumedAt));
}
