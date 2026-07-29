import { randomUUID } from "node:crypto";
import { catalogProject, projectStore, } from "./state.js";
export const PROJECT_CATALOG_CAPABILITY = "project-catalog-v1";
export const MAX_PROJECT_CATALOG_PAGE_LIMIT = 200;
export const DEFAULT_PROJECT_CATALOG_PAGE_LIMIT = 50;
export const PROJECT_CATALOG_SNAPSHOT_TTL_MS = 30_000;
export const MAX_PROJECT_CATALOG_PAGE_BYTES = 48 * 1024;
export const MAX_PROJECT_CATALOG_SNAPSHOT_ROWS = 20_000;
export const MAX_PROJECT_CATALOG_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export class ProjectCatalog {
    source;
    now;
    snapshot = null;
    snapshotTimer = null;
    constructor(source, now = Date.now) {
        this.source = source;
        this.now = now;
    }
    state() {
        return this.source.catalogState();
    }
    subscribe(listener) {
        this.source.on("catalog", listener);
        return () => {
            const emitter = this.source;
            emitter.off?.("catalog", listener);
        };
    }
    eventsAfter(seq) {
        return this.source.catalogEventsAfter(seq);
    }
    acknowledge(seq) {
        return this.source.acknowledgeProjectCatalog(seq);
    }
    page(requestId, rawLimit, cursor) {
        this.expireSnapshot();
        const limit = this.limit(rawLimit);
        if (!cursor) {
            if (this.snapshot && this.snapshot.requestId !== requestId) {
                throw new ProjectCatalogError("SYNC_IN_PROGRESS", "another project catalog snapshot is in progress");
            }
            if (!this.snapshot) {
                const projects = [];
                let snapshotBytes = 0;
                for (const record of this.source.list()) {
                    const project = catalogProject(record);
                    snapshotBytes += Buffer.byteLength(JSON.stringify(project));
                    if (projects.length >= MAX_PROJECT_CATALOG_SNAPSHOT_ROWS || snapshotBytes > MAX_PROJECT_CATALOG_SNAPSHOT_BYTES) {
                        throw new ProjectCatalogError("SNAPSHOT_TOO_LARGE", "project catalog snapshot exceeds Peon memory bounds");
                    }
                    projects.push(project);
                }
                const state = this.state();
                this.snapshot = {
                    requestId,
                    epoch: state.epoch,
                    revision: state.revision,
                    barrierSeq: state.latestSeq,
                    projects,
                    offsets: new Map([["", 0]]),
                    nextCursors: new Map(),
                    expiresAt: this.now() + PROJECT_CATALOG_SNAPSHOT_TTL_MS,
                };
                this.scheduleSnapshotExpiry();
            }
        }
        const snapshot = this.snapshot;
        if (!snapshot || snapshot.requestId !== requestId) {
            throw new ProjectCatalogError("BAD_CURSOR", "project catalog snapshot is unavailable");
        }
        const key = cursor ?? "";
        const offset = snapshot.offsets.get(key);
        if (offset === undefined)
            throw new ProjectCatalogError("BAD_CURSOR", "invalid project catalog cursor");
        const projects = [];
        let pageBytes = 0;
        for (const project of snapshot.projects.slice(offset, offset + limit)) {
            const projectBytes = Buffer.byteLength(JSON.stringify(project));
            if (projects.length > 0 && pageBytes + projectBytes > MAX_PROJECT_CATALOG_PAGE_BYTES)
                break;
            projects.push(project);
            pageBytes += projectBytes;
        }
        const nextOffset = offset + projects.length;
        const hasMore = nextOffset < snapshot.projects.length;
        const cachedCursor = snapshot.nextCursors.get(key);
        const nextCursor = cachedCursor === undefined ? (hasMore ? randomUUID() : null) : cachedCursor;
        if (cachedCursor === undefined) {
            snapshot.nextCursors.set(key, nextCursor);
            if (nextCursor)
                snapshot.offsets.set(nextCursor, nextOffset);
        }
        snapshot.expiresAt = this.now() + PROJECT_CATALOG_SNAPSHOT_TTL_MS;
        this.scheduleSnapshotExpiry();
        return {
            requestId,
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            barrierSeq: snapshot.barrierSeq,
            projects,
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
    limit(raw) {
        if (raw === undefined)
            return DEFAULT_PROJECT_CATALOG_PAGE_LIMIT;
        if (!Number.isSafeInteger(raw) || raw <= 0) {
            throw new ProjectCatalogError("BAD_REQUEST", "project catalog limit must be a positive integer");
        }
        return Math.min(raw, MAX_PROJECT_CATALOG_PAGE_LIMIT);
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
        }, PROJECT_CATALOG_SNAPSHOT_TTL_MS);
        this.snapshotTimer.unref();
    }
    clearSnapshot() {
        this.snapshot = null;
        if (this.snapshotTimer)
            clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
    }
}
export class ProjectCatalogError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export const projectCatalog = new ProjectCatalog(projectStore);
