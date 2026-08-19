import type { AgentEvent } from "../agents/index.js";
import type { TranscriptEntry } from "./index.js";

export const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 50;
export const DEFAULT_TRANSCRIPT_TAIL_REPLAY_LIMIT = 50;
export const MAX_TRANSCRIPT_PAGE_LIMIT = 500;
export const MAX_TRANSCRIPT_CURSOR_LENGTH = 4_096;
export const MAX_TRANSCRIPT_EVENT_ID_LENGTH = 256;

interface TranscriptCursorPayload {
  version: 1;
  sessionId: string;
  beforeEventId: string;
}

interface IndexedTranscriptCursorPayload {
  version: 2;
  sessionId: string;
  beforeEventId: string;
  beforeIndexOffset: number;
}

export class TranscriptPaginationError extends Error {
  constructor(
    public readonly code: "BAD_REQUEST" | "BAD_CURSOR",
    message: string,
  ) {
    super(message);
  }
}

export interface TranscriptPage {
  events: Array<AgentEvent & { eventId: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

/** Resolve an SSE replay boundary. The stream is a live tail, not a second
 * history endpoint: a missing or unknown boundary replays only one newest
 * window. Clients recover older gaps through the paginated HTTP transcript. */
export function transcriptResumeIndex(entries: TranscriptEntry[], cursor: string | undefined): number {
  const boundedFallback = () => Math.max(0, entries.length - DEFAULT_TRANSCRIPT_TAIL_REPLAY_LIMIT);
  if (cursor === undefined || cursor === "") return boundedFallback();
  const durableIndex = entries.findIndex((entry) => entry.id === cursor);
  if (durableIndex >= 0) return durableIndex + 1;
  // One-release bridge for clients reconnecting with the former numeric
  // position id after upgrading the Peon beneath an open stream.
  if (/^\d+$/.test(cursor)) return Math.min(Number(cursor), entries.length);
  return boundedFallback();
}

export function parseTranscriptResumeEventId(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "string" ||
    raw.length > MAX_TRANSCRIPT_EVENT_ID_LENGTH ||
    (raw.length > 0 && !/^[A-Za-z0-9_-]+$/.test(raw))
  ) {
    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript event id");
  }
  return raw;
}

export function parseTranscriptPageRequest(
  rawLimit: unknown,
  rawCursor: unknown,
): { limit: number; cursor?: string } | null {
  if (rawLimit === undefined && rawCursor === undefined) return null;

  let limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)) {
      throw new TranscriptPaginationError("BAD_REQUEST", "limit must be a positive integer");
    }
    // Avoid constructing an arbitrarily large BigInt from hostile query text.
    limit = rawLimit.length > 6 ? MAX_TRANSCRIPT_PAGE_LIMIT : Math.min(Number(rawLimit), MAX_TRANSCRIPT_PAGE_LIMIT);
  }

  if (rawCursor === undefined) return { limit };
  if (typeof rawCursor !== "string" || rawCursor.length === 0 || rawCursor.length > MAX_TRANSCRIPT_CURSOR_LENGTH) {
    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
  }
  return { limit, cursor: rawCursor };
}

function encodeCursor(sessionId: string, beforeEventId: string): string {
  const payload: TranscriptCursorPayload = { version: 1, sessionId, beforeEventId };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function encodeIndexedTranscriptCursor(sessionId: string, beforeEventId: string, beforeIndexOffset: number): string {
  const payload: IndexedTranscriptCursorPayload = { version: 2, sessionId, beforeEventId, beforeIndexOffset };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeTranscriptCursor(
  cursor: string,
  sessionId: string,
): { beforeEventId: string; beforeIndexOffset?: number } {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
  }
  const candidate = payload as {
    version?: unknown;
    sessionId?: unknown;
    beforeEventId?: unknown;
    beforeIndexOffset?: unknown;
  } | null;
  if (
    !candidate ||
    candidate.sessionId !== sessionId ||
    typeof candidate.beforeEventId !== "string" ||
    candidate.beforeEventId.length === 0 ||
    !SAFE_CURSOR_EVENT_ID.test(candidate.beforeEventId)
  ) {
    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
  }
  if (candidate.version === 1) return { beforeEventId: candidate.beforeEventId };
  if (
    candidate.version === 2 &&
    typeof candidate.beforeIndexOffset === "number" &&
    Number.isSafeInteger(candidate.beforeIndexOffset) &&
    candidate.beforeIndexOffset >= 0
  ) {
    return { beforeEventId: candidate.beforeEventId, beforeIndexOffset: candidate.beforeIndexOffset };
  }
  throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
}

const SAFE_CURSOR_EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/;

function decodeCursor(cursor: string, sessionId: string): string {
  return decodeTranscriptCursor(cursor, sessionId).beforeEventId;
}

export function paginateTranscript(
  sessionId: string,
  entries: TranscriptEntry[],
  cursorOptions: { limit: number; cursor?: string },
): TranscriptPage {
  let end = entries.length;
  if (cursorOptions.cursor) {
    const beforeEventId = decodeCursor(cursorOptions.cursor, sessionId);
    end = entries.findIndex((entry) => entry.id === beforeEventId);
    if (end < 0) throw new TranscriptPaginationError("BAD_CURSOR", "transcript cursor is no longer available");
  }

  const start = Math.max(0, end - cursorOptions.limit);
  const page = entries.slice(start, end);
  const hasMore = start > 0;
  return {
    events: page.map(({ id, event }) => ({ ...structuredClone(event), eventId: id })),
    nextCursor: hasMore && page[0] ? encodeCursor(sessionId, page[0].id) : null,
    hasMore,
  };
}
