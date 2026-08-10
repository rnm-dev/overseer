export type ProjectionVersion = number | null | undefined;

export function projectionIsStale(current: ProjectionVersion, incoming: ProjectionVersion): boolean {
  return current != null && incoming != null && current > incoming;
}

/** One monotonic keyed merge for REST pages, socket upserts and local caches. */
export function mergeResourceProjection<T>(
  current: readonly T[],
  incoming: readonly T[],
  identity: (item: T) => string,
  version: (item: T) => ProjectionVersion,
  merge: (previous: T | undefined, incoming: T) => T = (previous, item) => ({ ...previous, ...item }),
): T[] {
  const items = new Map(current.map((item) => [identity(item), item]));
  for (const item of incoming) {
    const key = identity(item);
    const previous = items.get(key);
    if (previous && projectionIsStale(version(previous), version(item))) continue;
    items.set(key, merge(previous, item));
  }
  return [...items.values()];
}
