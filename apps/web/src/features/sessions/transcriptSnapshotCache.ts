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
type TranscriptRequest = (path: string) => Promise<TranscriptResponse>;

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
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = request(
    transcriptPageUrl(base, sid, paginationSupported),
  )
    .then((response) => remember(key, parseTranscriptPage(response)))
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export function clearTranscriptSnapshotCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
