import type { FolderListEntry, FolderListInput, FolderListResult } from "../../peonFolderListing.js";

export interface ProjectDocsListing {
  exists: boolean;
  entries: FolderListEntry[];
}

export type FolderLister = (peonId: string, input: FolderListInput, signal?: AbortSignal) => Promise<FolderListResult>;

export interface RetryOptions {
  attempts?: number;
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}
