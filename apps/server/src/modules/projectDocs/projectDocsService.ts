import { type FolderListEntry, type ProjectDocsListing } from "./projectDocsTypes.js";

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
