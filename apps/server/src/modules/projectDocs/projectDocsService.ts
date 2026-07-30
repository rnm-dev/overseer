import { type FolderListEntry, listFolder } from "../../peonFolderListing.js";
import { listFolderReliably } from "../../peonFolderRetry.js";
import { PeonOperationError } from "../../peonOperationChannel.js";
import { type FolderLister, type ProjectDocsListing, type RetryOptions } from "./projectDocsTypes.js";

export function childPath(root: string, name: string): string {
  const separator = /^[a-z]:[\\/]/i.test(root) && !root.includes("/") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  return `${trimmed || separator}${trimmed ? separator : ""}${name}`;
}

// `project.documentation.index` carries the Peon's own recursive snapshot
// (`{ exists, indexPath, index, tree }`), while the route's public contract is
// the flat `docs/` listing both clients read. The snapshot's top-level `tree`
// *is* that directory, so normalize it here rather than teaching every client a
// second shape for the same route.
export function projectDocsFromSnapshot(snapshot: {
  exists?: unknown;
  tree?: unknown;
}): ProjectDocsListing {
  if (snapshot.exists !== true || !Array.isArray(snapshot.tree)) return { exists: false, entries: [] };
  const entries: FolderListEntry[] = [];
  for (const node of snapshot.tree as Array<Record<string, unknown>>) {
    if (node.type === "file") {
      entries.push({
        name: String(node.name),
        type: "file",
        size: typeof node.size === "number" ? node.size : null,
        mtimeMs: typeof node.mtimeMs === "number" ? node.mtimeMs : null,
      });
    } else if (node.type === "directory") {
      entries.push({ name: String(node.name), type: "directory", size: null, mtimeMs: null });
    }
  }
  return { exists: true, entries };
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
