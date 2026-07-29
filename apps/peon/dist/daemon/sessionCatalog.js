import { randomUUID } from "node:crypto";
import { sessions } from "./sessions/index.js";
import { toSessionSummary } from "./sessionSummary.js";
export const SESSION_CATALOG_CAPABILITY = "session-catalog-v1";
export const MAX_SESSION_CATALOG_EVENTS = 1_000;
export const MAX_SESSION_CATALOG_PAGE_LIMIT = 200;
export const DEFAULT_SESSION_CATALOG_PAGE_LIMIT = 50;
export const SESSION_CATALOG_SNAPSHOT_TTL_MS = 30_000;
export const MAX_SESSION_CATALOG_PAGE_BYTES = 48 * 1024;
export const MAX_SESSION_CATALOG_SNAPSHOT_ROWS = 20_000;
export const MAX_SESSION_CATALOG_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export class SessionCatalog {
    source;
    now;
    epoch = randomUUID();
    revision = 0;
    seq = 0;
    journal = [];
    listeners = new Set();
    snapshot = null;
    snapshotTimer = null;
    started = false;
    constructor(source, now = Date.now) {
        this.source = source;
        this.now = now;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.source.on("change", (record) => this.append({ session: toSessionSummary(record) }));
        this.source.on("delete", (sessionId) => this.append({ deletedSessionId: sessionId }));
    }
    state() {
        return {
            epoch: this.epoch,
            revision: this.revision,
            earliestSeq: this.journal[0]?.seq ?? this.seq + 1,
            latestSeq: this.seq,
        };
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    eventsAfter(seq) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.seq)
            return null;
        const earliest = this.journal[0]?.seq ?? this.seq + 1;
        if (seq < earliest - 1)
            return null;
        return this.journal.filter((event) => event.seq > seq);
    }
    acknowledge(seq) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.seq)
            return false;
        this.journal = this.journal.filter((event) => event.seq > seq);
        return true;
    }
    page(requestId, rawLimit, cursor) {
        this.expireSnapshot();
        const limit = this.limit(rawLimit);
        if (!cursor) {
            if (this.snapshot && this.snapshot.requestId !== requestId) {
                throw new SessionCatalogError("SYNC_IN_PROGRESS", "another session catalog snapshot is in progress");
            }
            if (!this.snapshot) {
                const summaries = [];
                let snapshotBytes = 0;
                for (const record of this.source.list()) {
                    const summary = toSessionSummary(record);
                    snapshotBytes += Buffer.byteLength(JSON.stringify(summary));
                    if (summaries.length >= MAX_SESSION_CATALOG_SNAPSHOT_ROWS || snapshotBytes > MAX_SESSION_CATALOG_SNAPSHOT_BYTES) {
                        throw new SessionCatalogError("SNAPSHOT_TOO_LARGE", "session catalog snapshot exceeds Peon memory bounds");
                    }
                    summaries.push(summary);
                }
                this.snapshot = {
                    requestId,
                    revision: this.revision,
                    barrierSeq: this.seq,
                    summaries,
                    offsets: new Map([["", 0]]),
                    nextCursors: new Map(),
                    expiresAt: this.now() + SESSION_CATALOG_SNAPSHOT_TTL_MS,
                };
                this.scheduleSnapshotExpiry();
            }
        }
        const snapshot = this.snapshot;
        if (!snapshot || snapshot.requestId !== requestId) {
            throw new SessionCatalogError("BAD_CURSOR", "session catalog snapshot is unavailable");
        }
        const key = cursor ?? "";
        const offset = snapshot.offsets.get(key);
        if (offset === undefined)
            throw new SessionCatalogError("BAD_CURSOR", "invalid session catalog cursor");
        const sessionsPage = [];
        let pageBytes = 0;
        for (const summary of snapshot.summaries.slice(offset, offset + limit)) {
            const summaryBytes = Buffer.byteLength(JSON.stringify(summary));
            if (sessionsPage.length > 0 && pageBytes + summaryBytes > MAX_SESSION_CATALOG_PAGE_BYTES)
                break;
            sessionsPage.push(summary);
            pageBytes += summaryBytes;
        }
        const nextOffset = offset + sessionsPage.length;
        const hasMore = nextOffset < snapshot.summaries.length;
        const cachedCursor = snapshot.nextCursors.get(key);
        const nextCursor = cachedCursor === undefined ? (hasMore ? randomUUID() : null) : cachedCursor;
        if (cachedCursor === undefined) {
            snapshot.nextCursors.set(key, nextCursor);
            if (nextCursor)
                snapshot.offsets.set(nextCursor, nextOffset);
        }
        snapshot.expiresAt = this.now() + SESSION_CATALOG_SNAPSHOT_TTL_MS;
        this.scheduleSnapshotExpiry();
        return {
            requestId,
            epoch: this.epoch,
            revision: snapshot.revision,
            barrierSeq: snapshot.barrierSeq,
            sessions: sessionsPage,
            nextCursor,
            hasMore,
        };
    }
    cancel(requestId) {
        if (this.snapshot?.requestId === requestId)
            this.clearSnapshot();
    }
    cancelActiveSnapshot() {
        this.clearSnapshot();
    }
    append(value) {
        this.seq += 1;
        this.revision += 1;
        const event = { seq: this.seq, revision: this.revision, ...value };
        this.journal.push(event);
        if (this.journal.length > MAX_SESSION_CATALOG_EVENTS) {
            this.journal = this.journal.slice(-MAX_SESSION_CATALOG_EVENTS);
        }
        for (const listener of this.listeners)
            listener(event);
    }
    expireSnapshot() {
        if (this.snapshot && this.snapshot.expiresAt <= this.now())
            this.clearSnapshot();
    }
    scheduleSnapshotExpiry() {
        if (this.snapshotTimer)
            clearTimeout(this.snapshotTimer);
        this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null;
            this.expireSnapshot();
            if (this.snapshot)
                this.scheduleSnapshotExpiry();
        }, SESSION_CATALOG_SNAPSHOT_TTL_MS);
        this.snapshotTimer.unref();
    }
    clearSnapshot() {
        this.snapshot = null;
        if (this.snapshotTimer)
            clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
    }
    limit(raw) {
        if (raw === undefined)
            return DEFAULT_SESSION_CATALOG_PAGE_LIMIT;
        if (!Number.isSafeInteger(raw) || raw <= 0) {
            throw new SessionCatalogError("BAD_REQUEST", "session catalog limit must be a positive integer");
        }
        return Math.min(raw, MAX_SESSION_CATALOG_PAGE_LIMIT);
    }
}
export class SessionCatalogError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export const sessionCatalog = new SessionCatalog(sessions);
