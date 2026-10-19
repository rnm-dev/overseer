// Best-effort browser storage. Restricted/private storage (or no window at all)
// must never break the UI, so reads fall back to null and writes are dropped.

export type ReadableStorage = Pick<Storage, "getItem">;
export type WritableStorage = Pick<Storage, "setItem">;

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function readStoredValue(key: string, storage?: ReadableStorage): string | null {
  try {
    return (storage ?? browserStorage())?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredValue(key: string, value: string, storage?: WritableStorage): void {
  try {
    (storage ?? browserStorage())?.setItem(key, value);
  } catch {
    // Storage may be disabled; the in-memory state still applies for this visit.
  }
}

export function readStoredJson(key: string, storage?: ReadableStorage): unknown {
  const raw = readStoredValue(key, storage);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
