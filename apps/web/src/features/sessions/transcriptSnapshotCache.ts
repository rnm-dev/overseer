import { api } from "../../shared/api";
import {
  parseTranscriptPage,
  transcriptPageUrl,
  type TranscriptPage,
  type TranscriptResponse,
} from "./transcriptPagination";

const MAX_TRANSCRIPTS = 12;
const PREFETCH_FRESH_MS = 5_000;

interface CachedTranscript {
  page: TranscriptPage;
  storedAt: number;
}

const cache = new Map<string, CachedTranscript>();
const inFlight = new Map<string, Promise<TranscriptPage>>();
let generation = 0;
type TranscriptRequest = (path: string) => Promise<TranscriptResponse>;

export class StaleTranscriptSnapshotError extends Error {
  constructor() {
    super("Transcript snapshot was invalidated");
    this.name = "StaleTranscriptSnapshotError";
  }
}

function cacheKey(base: string, sid: string, paginationSupported: boolean): string {
  return `${base}\0${sid}\0${paginationSupported ? "paginated" : "legacy"}`;
}

function remember(key: string, page: TranscriptPage, storedAt = Date.now()): TranscriptPage {
  cache.delete(key);
  cache.set(key, { page, storedAt });
  while (cache.size > MAX_TRANSCRIPTS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return page;
}

export function cachedTranscriptSnapshot(
  base: string,
  sid: string,
  paginationSupported: boolean,
): TranscriptPage | null {
  const key = cacheKey(base, sid, paginationSupported);
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  cache.set(key, entry);
  return entry.page;
}

export function rememberTranscriptSnapshot(
  base: string,
  sid: string,
  paginationSupported: boolean,
  page: TranscriptPage,
): TranscriptPage {
  return remember(cacheKey(base, sid, paginationSupported), page);
}

export function preparedTranscriptSnapshot(
  base: string,
  sid: string,
  paginationSupported: boolean,
): Promise<TranscriptPage> | null {
  const key = cacheKey(base, sid, paginationSupported);
  // An in-flight prefetch is the current HTTP newest-page request. A completed
  // cache entry is only paint data: opening must revalidate it over HTTP before
  // choosing the live-tail boundary.
  return inFlight.get(key) ?? null;
}

function startTranscriptSnapshotRequest(
  base: string,
  sid: string,
  paginationSupported: boolean,
  request: TranscriptRequest,
): Promise<TranscriptPage> {
  const key = cacheKey(base, sid, paginationSupported);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const requestGeneration = generation;

  const promise = request(
    transcriptPageUrl(base, sid, paginationSupported),
  )
    .then((response) => {
      const page = parseTranscriptPage(response);
      if (requestGeneration !== generation) throw new StaleTranscriptSnapshotError();
      return remember(key, page);
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

// Opening a session must revalidate paint-only cache data before choosing a
// live-tail boundary. The request itself is still single-flighted so React
// StrictMode's mount replay cannot duplicate a large Fleet HTTP transcript read.
export function readAuthoritativeTranscriptSnapshot(
  base: string,
  sid: string,
  paginationSupported: boolean,
  request: TranscriptRequest = (path) => api<TranscriptResponse>(path),
): Promise<TranscriptPage> {
  return startTranscriptSnapshotRequest(base, sid, paginationSupported, request);
}

export function prefetchTranscriptSnapshot(
  base: string,
  sid: string,
  paginationSupported: boolean,
  request: TranscriptRequest = (path) => api<TranscriptResponse>(path),
  now = Date.now(),
): Promise<TranscriptPage> {
  const key = cacheKey(base, sid, paginationSupported);
  const cached = cache.get(key);
  if (cached && now - cached.storedAt <= PREFETCH_FRESH_MS) {
    return Promise.resolve(cached.page);
  }
  return startTranscriptSnapshotRequest(base, sid, paginationSupported, request);
}

export function clearTranscriptSnapshotCache(): void {
  generation += 1;
  cache.clear();
  inFlight.clear();
}

export const clearTranscriptSnapshotCacheForTests = clearTranscriptSnapshotCache;
