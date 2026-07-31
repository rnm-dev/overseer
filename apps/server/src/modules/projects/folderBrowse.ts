import { PeonOperationError } from "../../peonOperationChannel.js";

export interface FolderBrowseSelector {
  path: string;
  limit?: number;
}

export const DEFAULT_BROWSE_PATH = "/";

function singleQueryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PeonOperationError("BAD_REQUEST", "query parameter must be a single value", 400);
  return value;
}

// Query string → the host-filesystem selector. Only absolute paths are
// browsable here; project-relative listing keeps its own dedicated route.
export function folderBrowseSelector(path: unknown, limit: unknown): FolderBrowseSelector {
  const rawPath = singleQueryValue(path);
  const rawLimit = singleQueryValue(limit);
  const selector: FolderBrowseSelector = { path: rawPath?.trim() || DEFAULT_BROWSE_PATH };
  if (!/^(?:\/|[a-z]:[\\/])/i.test(selector.path)) {
    throw new PeonOperationError("BAD_REQUEST", "path must be absolute", 400);
  }
  if (rawLimit !== undefined && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 500) {
      throw new PeonOperationError("BAD_REQUEST", "limit must be an integer between 1 and 500", 400);
    }
    selector.limit = parsed;
  }
  return selector;
}
