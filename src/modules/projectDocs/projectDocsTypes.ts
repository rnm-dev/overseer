import type { FolderListEntry } from "../../peonFolderListing.js";

export type { FolderLister, RetryOptions } from "../../peonFolderRetry.js";

export interface ProjectDocsListing {
  exists: boolean;
  entries: FolderListEntry[];
}
