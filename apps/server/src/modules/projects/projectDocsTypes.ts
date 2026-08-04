export interface FolderListEntry {
  name: string;
  type: "directory" | "file" | "other";
  size: number | null;
  mtimeMs: number | null;
}

export interface ProjectDocsListing {
  exists: boolean;
  entries: FolderListEntry[];
}
