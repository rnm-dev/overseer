// Best-effort browser storage. Restricted/private storage (or none at all)
// must never break the UI, so reads fall back to null and writes are dropped.

export function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be disabled; the in-memory state still applies for this visit.
  }
}

export function readStoredJson(key: string): unknown {
  const raw = readStoredValue(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
