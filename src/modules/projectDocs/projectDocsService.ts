import { listFolder, type FolderListInput } from "../../peonFolderListing.js";
import { PeonOperationError } from "../../peonOperationChannel.js";
import { type FolderLister, type ProjectDocsListing, type RetryOptions } from "./projectDocsTypes.js";

const TRANSIENT_LIST_CODES = new Set(["SYNC_IN_PROGRESS"]);

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new PeonOperationError("CANCELLED", "operation was cancelled", 499));
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = () => {
      clearTimeout(timer);
      reject(new PeonOperationError("CANCELLED", "operation was cancelled", 499));
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function reliableList(
  peonId: string,
  input: FolderListInput,
  signal: AbortSignal | undefined,
  request: FolderLister,
  retry: RetryOptions,
): Promise<Awaited<ReturnType<FolderLister>>> {
  const attempts = retry.attempts ?? 7;
  const wait = retry.pause ?? pause;
  const random = retry.random ?? Math.random;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(peonId, input, signal);
    } catch (error) {
      if (!(error instanceof PeonOperationError) || !TRANSIENT_LIST_CODES.has(error.code) || attempt >= attempts - 1) throw error;
      const base = Math.min(50 * (2 ** attempt), 500);
      await wait(Math.round(base * (0.75 + random() * 0.5)), signal);
    }
  }
}

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
  const root = await reliableList(peonId, { projectId }, signal, request, retry);
  const docs = root.entries.find((entry) => entry.name === "docs" && entry.type === "directory");
  if (!docs) return { exists: false, entries: [] };

  try {
    const listing = await reliableList(peonId, { path: childPath(root.path, docs.name) }, signal, request, retry);
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
