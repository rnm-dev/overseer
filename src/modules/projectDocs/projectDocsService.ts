import { listFolder } from "../../peonFolderListing.js";
import { listFolderReliably } from "../../peonFolderRetry.js";
import { PeonOperationError } from "../../peonOperationChannel.js";
import { type FolderLister, type ProjectDocsListing, type RetryOptions } from "./projectDocsTypes.js";

export function childPath(root: string, name: string): string {
  const separator = /^[a-z]:[\\/]/i.test(root) && !root.includes("/") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  return `${trimmed || separator}${trimmed ? separator : ""}${name}`;
}

export async function listProjectDocs(
  peonId: string,
  projectId: string,
  signal?: AbortSignal,
  request: FolderLister = listFolder,
  retry: RetryOptions = {},
): Promise<ProjectDocsListing> {
  const root = await listFolderReliably(peonId, { projectId }, signal, request, retry);
  const docs = root.entries.find((entry) => entry.name === "docs" && entry.type === "directory");
  if (!docs) return { exists: false, entries: [] };

  try {
    const listing = await listFolderReliably(peonId, { path: childPath(root.path, docs.name) }, signal, request, retry);
    return { exists: true, entries: listing.entries };
  } catch (error) {
    // The folder may disappear between the root snapshot and the nested read.
    // Treat that ordinary race exactly like a root listing without docs.
    if (error instanceof PeonOperationError && error.code === "NOT_FOUND") {
      return { exists: false, entries: [] };
    }
    throw error;
  }
}
