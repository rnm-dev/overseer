export const DEFAULT_TRANSCRIPT_PAGE_LIMIT = 50;
/** A missing or unknown SSE boundary replays only this newest window. */
export const DEFAULT_TRANSCRIPT_TAIL_REPLAY_LIMIT = 50;
export const MAX_TRANSCRIPT_PAGE_LIMIT = 500;
export const MAX_TRANSCRIPT_CURSOR_LENGTH = 4_096;
export const MAX_TRANSCRIPT_EVENT_ID_LENGTH = 256;
export class TranscriptPaginationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function parseTranscriptResumeEventId(raw) {
    if (raw === undefined)
        return undefined;
    if (typeof raw !== "string" ||
        raw.length > MAX_TRANSCRIPT_EVENT_ID_LENGTH ||
        (raw.length > 0 && !/^[A-Za-z0-9_-]+$/.test(raw))) {
        throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript event id");
    }
    return raw;
}
export function parseTranscriptPageRequest(rawLimit, rawCursor) {
    if (rawLimit === undefined && rawCursor === undefined)
        return null;
    let limit = DEFAULT_TRANSCRIPT_PAGE_LIMIT;
    if (rawLimit !== undefined) {
        if (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit)) {
            throw new TranscriptPaginationError("BAD_REQUEST", "limit must be a positive integer");
        }
        // Avoid constructing an arbitrarily large BigInt from hostile query text.
        limit = rawLimit.length > 6 ? MAX_TRANSCRIPT_PAGE_LIMIT : Math.min(Number(rawLimit), MAX_TRANSCRIPT_PAGE_LIMIT);
    }
    if (rawCursor === undefined)
        return { limit };
    if (typeof rawCursor !== "string" || rawCursor.length === 0 || rawCursor.length > MAX_TRANSCRIPT_CURSOR_LENGTH) {
        throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
    }
    return { limit, cursor: rawCursor };
}
export function encodeIndexedTranscriptCursor(sessionId, beforeEventId, beforeIndexOffset) {
    const payload = { version: 2, sessionId, beforeEventId, beforeIndexOffset };
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
export function decodeTranscriptCursor(cursor, sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    }
    catch {
        throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
    }
    const candidate = payload;
    if (!candidate ||
        candidate.sessionId !== sessionId ||
        typeof candidate.beforeEventId !== "string" ||
        candidate.beforeEventId.length === 0 ||
        !SAFE_CURSOR_EVENT_ID.test(candidate.beforeEventId)) {
        throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
    }
    if (candidate.version === 1)
        return { beforeEventId: candidate.beforeEventId };
    if (candidate.version === 2 &&
        typeof candidate.beforeIndexOffset === "number" &&
        Number.isSafeInteger(candidate.beforeIndexOffset) &&
        candidate.beforeIndexOffset >= 0) {
        return { beforeEventId: candidate.beforeEventId, beforeIndexOffset: candidate.beforeIndexOffset };
    }
    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
}
const SAFE_CURSOR_EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/;
