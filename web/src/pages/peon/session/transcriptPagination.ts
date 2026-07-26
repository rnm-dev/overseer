import type { Ev } from "./parsing";

// Tool-result events can be hundreds of KiB even though their output is folded
// in the UI. Keep the initial render bounded; older history remains available
// through the existing opaque-cursor pagination control.
export const TRANSCRIPT_PAGE_SIZE = 50;
// Opening a session with only 50 events lands mid-conversation too often, so the
// first (cursor-less, newest) page pulls three pages' worth up front; subsequent
// older pages stay at TRANSCRIPT_PAGE_SIZE.
export const TRANSCRIPT_INITIAL_PAGE_SIZE = TRANSCRIPT_PAGE_SIZE * 3;

export type TranscriptResponse = Ev[] | {
  events?: Ev[];
  nextCursor?: string | null;
  hasMore?: boolean;
};

export interface TranscriptPage {
  events: Ev[];
  paginated: boolean;
  nextCursor: string | null;
  hasMore: boolean;
}

export type LoadedTranscript = TranscriptPage;

export function eventId(event: Ev): string | null {
  return typeof event.eventId === "string" && event.eventId ? event.eventId : null;
}

export function parseTranscriptPage(result: TranscriptResponse): TranscriptPage {
  if (Array.isArray(result)) return { events: result, paginated: false, nextCursor: null, hasMore: false };
  const events = Array.isArray(result.events) ? result.events : [];
  if (typeof result.hasMore !== "boolean") return { events, paginated: false, nextCursor: null, hasMore: false };
  const nextCursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
  return { events, paginated: true, nextCursor, hasMore: result.hasMore && nextCursor !== null };
}

export function mergeNewestPage(current: LoadedTranscript | null, page: TranscriptPage): LoadedTranscript {
  if (!page.paginated || !current?.paginated) return { ...page };
  const incoming = new Map<string, Ev>();
  for (const event of page.events) {
    const id = eventId(event);
    if (id) incoming.set(id, event);
  }
  const events = current.events.map((event) => {
    const id = eventId(event);
    return id ? incoming.get(id) ?? event : event;
  });
  const seen = new Set(events.flatMap((event) => eventId(event) ?? []));
  for (const event of page.events) {
    const id = eventId(event);
    if (!id || !seen.has(id)) events.push(event);
    if (id) seen.add(id);
  }
  return { ...current, events };
}

export function prependOlderPage(current: LoadedTranscript, page: TranscriptPage): LoadedTranscript {
  if (!page.paginated) return { ...page };
  const currentIds = new Set(current.events.flatMap((event) => eventId(event) ?? []));
  const events = [...page.events.filter((event) => {
    const id = eventId(event);
    return !id || !currentIds.has(id);
  }), ...current.events];
  return { events, paginated: true, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

export function pagesOverlap(events: Ev[], knownIds: Set<string>): boolean {
  return events.some((event) => {
    const id = eventId(event);
    return id !== null && knownIds.has(id);
  });
}

export function transcriptPageUrl(base: string, sid: string, supported: boolean, cursor?: string): string {
  const path = `${base}/sessions/${encodeURIComponent(sid)}/transcript`;
  if (!supported) return path;
  const params = new URLSearchParams({
    limit: String(cursor ? TRANSCRIPT_PAGE_SIZE : TRANSCRIPT_INITIAL_PAGE_SIZE),
  });
  if (cursor) params.set("cursor", cursor);
  return `${path}?${params}`;
}
