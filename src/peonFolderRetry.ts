import { listFolder, type FolderListInput, type FolderListResult } from "./peonFolderListing.js";
import { PeonOperationError } from "./peonOperationChannel.js";

// A Peon runs one folder listing at a time — the operation channel single-flights
// per Peon — so an overlapping reader is refused with SYNC_IN_PROGRESS: another
// operator, the docs panel, or a superseded picker request whose cancellation has
// not reached the Peon yet. That refusal is transient by construction, so every
// caller waits its turn instead of showing the operator a "busy" dead end.

const TRANSIENT_LIST_CODES = new Set(["SYNC_IN_PROGRESS"]);

export type FolderLister = (peonId: string, input: FolderListInput, signal?: AbortSignal) => Promise<FolderListResult>;

export interface RetryOptions {
  attempts?: number;
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
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

export async function listFolderReliably(
  peonId: string,
  input: FolderListInput,
  signal: AbortSignal | undefined,
  request: FolderLister = listFolder,
  retry: RetryOptions = {},
): Promise<FolderListResult> {
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
