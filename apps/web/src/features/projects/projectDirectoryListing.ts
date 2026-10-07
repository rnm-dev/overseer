import { api } from "../../shared/api";
import { projectDirectoryListingPath } from "./fileLinks";

export interface ProjectFileEntry {
  name: string;
  type?: string;
  size?: number;
  mtimeMs?: number;
}

type DirectoryResponse = { entries?: ProjectFileEntry[] };
type DirectoryRequest = (path: string) => Promise<DirectoryResponse>;

const inFlight = new Map<string, Promise<ProjectFileEntry[]>>();

// React StrictMode deliberately remounts effects in development. A directory
// read already in flight belongs to the resource rather than either component
// instance, so both mounts share it. Settled reads are never cached: Refresh
// remains an authoritative new request.
export function requestProjectDirectory(
  filesBase: string,
  path: string,
  request: DirectoryRequest = (url) => api(url, { cache: "no-store" }),
): Promise<ProjectFileEntry[]> {
  const url = projectDirectoryListingPath(filesBase, path);
  const pending = inFlight.get(url);
  if (pending) return pending;
  const created = request(url)
    .then((result) => result.entries ?? [])
    .finally(() => {
      if (inFlight.get(url) === created) inFlight.delete(url);
    });
  inFlight.set(url, created);
  return created;
}

// An event may land during the initial HTTP read. Wait out that pre-event
// snapshot before asking for the authoritative post-event one.
export async function refreshProjectDirectory(
  filesBase: string, path: string,
  request?: DirectoryRequest,
): Promise<ProjectFileEntry[]> {
  const pending = inFlight.get(projectDirectoryListingPath(filesBase, path));
  if (pending) { try { await pending; } catch { /* retry the failed snapshot */ } }
  return requestProjectDirectory(filesBase, path, request);
}
