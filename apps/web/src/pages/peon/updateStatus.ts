export interface PeonUpdateStatus {
  updateAvailable?: boolean;
  updateCurrentVersion?: string | null;
  updateLatestVersion?: string | null;
  updateCurrentRevision?: string | null;
  updateLatestRevision?: string | null;
  updateCheckedAt?: number | null;
  updateCheckError?: string | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Two peon responses describe the same thing in different shapes: GET /status
// flattens the fields with an `update` prefix, while POST /control/check-update
// answers with a bounded `{ status, code, result: { currentVersion, … } }`
// envelope. Read both into one view so an explicit check never blanks out the
// versions the periodic status already showed.
export function normalizeUpdateStatus(raw: unknown): PeonUpdateStatus {
  const root = object(raw) ?? {};
  const result = object(root.result) ?? {};
  const field = (flat: string, nested: string) => (flat in root ? root[flat] : result[nested]);
  const available = field("updateAvailable", "updateAvailable");
  return {
    updateAvailable: typeof available === "boolean" ? available : root.status === "available",
    updateCurrentVersion: text(field("updateCurrentVersion", "currentVersion")),
    updateLatestVersion: text(field("updateLatestVersion", "latestVersion")),
    updateCurrentRevision: text(field("updateCurrentRevision", "currentRevision")),
    updateLatestRevision: text(field("updateLatestRevision", "latestRevision")),
    updateCheckedAt: timestamp(field("updateCheckedAt", "checkedAt")),
    updateCheckError: text(field("updateCheckError", "checkError")),
  };
}
