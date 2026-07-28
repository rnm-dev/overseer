import { api, ApiError } from "../../api";

// Folder browsing for the directory picker. The overseer route behind this
// adapter talks to the Peon over the `folder-listing-v1` reverse WebSocket, so
// the operator can descend from `/` instead of the HTTP file-transfer root.
// Protocol/error handling lives here, never in the picker component.

export interface PeonFolderEntry {
  name: string;
  type: "directory";
}

export interface PeonFolderListing {
  path: string;
  entries: PeonFolderEntry[];
}

export type FolderBrowser = (path: string, signal?: AbortSignal) => Promise<PeonFolderListing>;

const MAX_ANCESTOR_STEPS = 24;

export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";

export function parentPath(value: string): string | null {
  const trimmed = value.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return null;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function listPeonFolder(base: string, path: string, signal?: AbortSignal): Promise<PeonFolderListing> {
  return api<PeonFolderListing>(`${base}/folders?path=${encodeURIComponent(path)}`, { signal });
}

// Opening the picker on a *suggested* directory is normal — the project folder
// does not exist yet. Fall back to the deepest ancestor that does, so the first
// view is a usable listing rather than a missing-directory error. Explicit
// navigation never falls back; there a wrong path must be reported.
export async function listNearestPeonFolder(
  base: string,
  path: string,
  signal?: AbortSignal,
  request: (path: string, signal?: AbortSignal) => Promise<PeonFolderListing> = (p, s) => listPeonFolder(base, p, s),
): Promise<PeonFolderListing> {
  let candidate: string | null = path;
  for (let step = 0; candidate && step < MAX_ANCESTOR_STEPS; step += 1) {
    try {
      return await request(candidate, signal);
    } catch (error) {
      const next: string | null = error instanceof ApiError && (error.code === "NOT_FOUND" || error.code === "NOT_DIRECTORY" || error.code === "INVALID_PATH")
        ? parentPath(candidate)
        : null;
      if (!next) throw error;
      candidate = next;
    }
  }
  return request("/", signal);
}

// Stable, translatable messages for every state the operation can end in.
export function folderErrorKey(error: unknown): string {
  if (!(error instanceof ApiError)) return "error.loadFailed";
  switch (error.code) {
    case "UNSUPPORTED_CAPABILITY":
      return "pathSelector.unsupported";
    case "PEON_OFFLINE":
    case "CONNECTION_LOST":
      return "pathSelector.offline";
    case "TIMEOUT":
      return "pathSelector.timeout";
    case "FORBIDDEN":
      return "pathSelector.forbidden";
    case "NOT_FOUND":
    case "UNKNOWN_PROJECT":
      return "pathSelector.missing";
    case "NOT_DIRECTORY":
      return "pathSelector.notDirectory";
    case "INVALID_PATH":
      return "pathSelector.invalidPath";
    case "SYNC_IN_PROGRESS":
      return "pathSelector.busy";
    case "LISTING_TOO_LARGE":
      return "pathSelector.tooLarge";
    default:
      return "error.loadFailed";
  }
}

// What the picker consumes: a strict listing for navigation and a forgiving one
// for the directory it opens on.
export interface FolderSource {
  list: FolderBrowser;
  resolve: FolderBrowser;
}

export function createPeonFolderSource(base: string): FolderSource {
  return {
    list: (path, signal) => listPeonFolder(base, path, signal),
    resolve: (path, signal) => listNearestPeonFolder(base, path, signal),
  };
}
