import { randomUUID } from "node:crypto";
/**
 * One bounded, frozen catalog snapshot. Domain adapters retain ownership of
 * rows, lifecycle events, persistence, and their released wire field names.
 */
export class CatalogSnapshotPager {
    options;
    snapshot = null;
    snapshotTimer = null;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }
    page(requestId, rawLimit, cursor) {
        this.expire();
        const limit = this.limit(rawLimit);
        if (!cursor)
            this.open(requestId);
        const snapshot = this.snapshot;
        if (!snapshot || snapshot.requestId !== requestId) {
            throw this.error("BAD_CURSOR", this.options.messages.unavailable);
        }
        const key = cursor ?? "";
        const offset = snapshot.offsets.get(key);
        if (offset === undefined)
            throw this.error("BAD_CURSOR", this.options.messages.invalidCursor);
        const rows = [];
        let pageBytes = 0;
        for (const row of snapshot.rows.slice(offset, offset + limit)) {
            const rowBytes = Buffer.byteLength(JSON.stringify(row));
            if (rows.length > 0 && pageBytes + rowBytes > this.options.maxPageBytes)
                break;
            rows.push(row);
            pageBytes += rowBytes;
        }
        const nextOffset = offset + rows.length;
        const hasMore = nextOffset < snapshot.rows.length;
        const cachedCursor = snapshot.nextCursors.get(key);
        const nextCursor = cachedCursor === undefined ? (hasMore ? randomUUID() : null) : cachedCursor;
        if (cachedCursor === undefined) {
            snapshot.nextCursors.set(key, nextCursor);
            if (nextCursor)
                snapshot.offsets.set(nextCursor, nextOffset);
        }
        snapshot.expiresAt = this.now() + this.options.ttlMs;
        this.scheduleExpiry();
        return {
            requestId,
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            barrierSeq: snapshot.barrierSeq,
            rows,
            nextCursor,
            hasMore,
        };
    }
    cancel(requestId) {
        if (this.snapshot?.requestId === requestId)
            this.clear();
    }
    cancelActive() {
        this.clear();
    }
    open(requestId) {
        if (this.snapshot && this.snapshot.requestId !== requestId) {
            throw this.error("SYNC_IN_PROGRESS", this.options.messages.syncInProgress);
        }
        if (this.snapshot)
            return;
        const rows = [];
        let snapshotBytes = 0;
        for (const row of this.options.rows()) {
            snapshotBytes += Buffer.byteLength(JSON.stringify(row));
            if (rows.length >= this.options.maxSnapshotRows || snapshotBytes > this.options.maxSnapshotBytes) {
                throw this.error("SNAPSHOT_TOO_LARGE", this.options.messages.tooLarge);
            }
            rows.push(row);
        }
        const state = this.options.state();
        this.snapshot = {
            requestId,
            epoch: state.epoch,
            revision: state.revision,
            barrierSeq: state.latestSeq,
            rows,
            offsets: new Map([["", 0]]),
            nextCursors: new Map(),
            expiresAt: this.now() + this.options.ttlMs,
        };
        this.scheduleExpiry();
    }
    limit(raw) {
        if (raw === undefined)
            return this.options.defaultPageLimit;
        if (!Number.isSafeInteger(raw) || raw <= 0) {
            throw this.error("BAD_REQUEST", this.options.messages.invalidLimit);
        }
        return Math.min(raw, this.options.maxPageLimit);
    }
    error(code, message) {
        return this.options.error(code, message);
    }
    expire() {
        if (this.snapshot && this.snapshot.expiresAt <= this.now())
            this.clear();
    }
    scheduleExpiry() {
        if (this.snapshotTimer)
            clearTimeout(this.snapshotTimer);
        this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null;
            this.expire();
            if (this.snapshot)
                this.scheduleExpiry();
        }, this.options.ttlMs);
        this.snapshotTimer.unref();
    }
    clear() {
        this.snapshot = null;
        if (this.snapshotTimer)
            clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
    }
}
