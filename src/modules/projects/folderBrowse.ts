import { listFolder, type FolderListInput } from "../../peonFolderListing.js";
import { listFolderReliably, type FolderLister, type RetryOptions } from "../../peonFolderRetry.js";
import { PeonOperationError } from "../../peonOperationChannel.js";

// Directory browsing for the operator's directory picker. It rides the Peon's
// `folder-listing-v1` reverse WebSocket operation (pagination, cancellation,
// timeout, bounds and capability negotiation all live there) — never the HTTP
// file-transfer proxy, which can only see `fileTransferRoot`.

export interface BrowsedFolder {
  path: string;
  entries: { name: string; type: "directory" }[];
}

export const DEFAULT_BROWSE_PATH = "/";

function singleQueryValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new PeonOperationError("BAD_REQUEST", "query parameter must be a single value", 400);
  return value;
}

// Query string → the folder-listing selector. Only absolute paths are browsable
// here; project-relative listing keeps its own dedicated use cases.
export function folderBrowseSelector(path: unknown, limit: unknown): FolderListInput {
  const rawPath = singleQueryValue(path);
  const rawLimit = singleQueryValue(limit);
  const selector: FolderListInput = { path: rawPath?.trim() || DEFAULT_BROWSE_PATH };
  if (rawLimit !== undefined && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PeonOperationError("BAD_REQUEST", "limit must be a positive integer", 400);
    selector.limit = parsed;
  }
  return selector;
}

// A Peon serves one listing at a time, so an overlapping reader — a superseded
// picker request still being cancelled, the docs panel, another operator — is
// refused with SYNC_IN_PROGRESS. Wait for the turn instead of telling the
// operator the Peon is busy.
export async function browsePeonFolders(
  peonId: string,
  selector: FolderListInput,
  signal?: AbortSignal,
  request: FolderLister = listFolder,
  retry: RetryOptions = {},
): Promise<BrowsedFolder> {
  const listing = await listFolderReliably(peonId, selector, signal, request, retry);
  const entries = listing.entries
    .filter((entry) => entry.type === "directory")
    .map((entry) => ({ name: entry.name, type: "directory" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: listing.path, entries };
}
