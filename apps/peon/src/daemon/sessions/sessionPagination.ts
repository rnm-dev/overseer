import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SessionRecord } from "./sessionTypes.js";

export const DEFAULT_SESSION_PAGE_LIMIT = 50;
export const MAX_SESSION_PAGE_LIMIT = 200;

// Cursors deliberately expire when the daemon restarts. They only represent a
// short-lived walk through the current session index, and an in-process random
// signing key detects payload edits without adding another persisted secret.
const cursorKey = randomBytes(32);

interface SessionSortPosition {
  activityAt: number;
  id: string;
}

interface CursorPayload extends SessionSortPosition {
  version: 1;
}

export class SessionPaginationError extends Error {
  constructor(
    public readonly code: "BAD_REQUEST" | "BAD_CURSOR",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionPage {
  sessions: SessionRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function parseSessionPageRequest(
  rawLimit: unknown,
  rawCursor: unknown,
): { limit: number; cursor?: string } | null {
  const paginated = rawLimit !== undefined || rawCursor !== undefined;
  if (!paginated) return null;

  let limit = DEFAULT_SESSION_PAGE_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)) {
      throw new SessionPaginationError("BAD_REQUEST", "limit must be a positive integer");
    }
    const parsed = BigInt(rawLimit);
    limit = parsed > BigInt(MAX_SESSION_PAGE_LIMIT) ? MAX_SESSION_PAGE_LIMIT : Number(parsed);
  }

  if (rawCursor === undefined) return { limit };
  if (typeof rawCursor !== "string" || rawCursor.length === 0) {
    throw new SessionPaginationError("BAD_CURSOR", "invalid session cursor");
  }
  return { limit, cursor: rawCursor };
}

function activityAt(record: Pick<SessionRecord, "lastActivityAt" | "startedAt">): number {
  return record.lastActivityAt ?? record.startedAt ?? 0;
}

// Negative means a sorts before b. Both keys are descending: newest activity
// first, then the lexicographically greater session id.
function comparePositions(a: SessionSortPosition, b: SessionSortPosition): number {
  if (a.activityAt !== b.activityAt) return b.activityAt - a.activityAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function position(record: Pick<SessionRecord, "id" | "lastActivityAt" | "startedAt">): SessionSortPosition {
  return { activityAt: activityAt(record), id: record.id };
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", cursorKey).update(encodedPayload).digest();
}

function encodeCursor(sortPosition: SessionSortPosition): string {
  const payload: CursorPayload = { version: 1, ...sortPosition };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
}

function decodeCursor(cursor: string): SessionSortPosition {
  const parts = cursor.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new SessionPaginationError("BAD_CURSOR", "invalid session cursor");
  }
  const [encodedPayload, encodedSignature] = parts;
  const actual = Buffer.from(encodedSignature, "base64url");
  const expected = sign(encodedPayload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new SessionPaginationError("BAD_CURSOR", "invalid session cursor");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new SessionPaginationError("BAD_CURSOR", "invalid session cursor");
  }
  const candidate = payload as Partial<CursorPayload> | null;
  if (
    !candidate ||
    candidate.version !== 1 ||
    typeof candidate.activityAt !== "number" ||
    !Number.isFinite(candidate.activityAt) ||
    typeof candidate.id !== "string" ||
    candidate.id.length === 0
  ) {
    throw new SessionPaginationError("BAD_CURSOR", "invalid session cursor");
  }
  return { activityAt: candidate.activityAt, id: candidate.id };
}

export function paginateSessions(
  records: Iterable<SessionRecord>,
  options: { limit: number; cursor?: string; projectKey?: string },
): SessionPage {
  const boundary = options.cursor ? decodeCursor(options.cursor) : null;
  const selected: SessionRecord[] = [];
  const readLimit = options.limit + 1;

  // The durable store is already resident in memory. Keep only the best
  // limit+1 matches while scanning it, rather than materializing and sorting a
  // second copy of the complete session collection for every page request.
  for (const record of records) {
    if (options.projectKey && record.projectKey !== options.projectKey) continue;
    const recordPosition = position(record);
    if (boundary && comparePositions(recordPosition, boundary) <= 0) continue;
    selected.push(record);
    selected.sort((a, b) => comparePositions(position(a), position(b)));
    if (selected.length > readLimit) selected.pop();
  }

  const hasMore = selected.length > options.limit;
  const page = hasMore ? selected.slice(0, options.limit) : selected;
  const finalRecord = page.at(-1);
  return {
    sessions: page,
    nextCursor: hasMore && finalRecord ? encodeCursor(position(finalRecord)) : null,
    hasMore,
  };
}
