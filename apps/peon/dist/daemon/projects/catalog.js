import { CatalogSnapshotPager } from "../catalog/snapshotPager.js";
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
    snapshots;
    constructor(source, now = Date.now) {
        this.source = source;
        this.snapshots = new CatalogSnapshotPager({
            defaultPageLimit: DEFAULT_PROJECT_CATALOG_PAGE_LIMIT,
            maxPageLimit: MAX_PROJECT_CATALOG_PAGE_LIMIT,
            maxPageBytes: MAX_PROJECT_CATALOG_PAGE_BYTES,
            maxSnapshotRows: MAX_PROJECT_CATALOG_SNAPSHOT_ROWS,
            maxSnapshotBytes: MAX_PROJECT_CATALOG_SNAPSHOT_BYTES,
            ttlMs: PROJECT_CATALOG_SNAPSHOT_TTL_MS,
            state: () => this.state(),
            rows: () => this.source.list().map(catalogProject),
            error: (code, message) => new ProjectCatalogError(code, message),
            messages: {
                unavailable: "project catalog snapshot is unavailable",
                invalidCursor: "invalid project catalog cursor",
                syncInProgress: "another project catalog snapshot is in progress",
                tooLarge: "project catalog snapshot exceeds Peon memory bounds",
                invalidLimit: "project catalog limit must be a positive integer",
            },
            now,
        });
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
        const snapshot = this.snapshots.page(requestId, rawLimit, cursor);
        return {
            requestId: snapshot.requestId,
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            barrierSeq: snapshot.barrierSeq,
            projects: snapshot.rows,
            nextCursor: snapshot.nextCursor,
            hasMore: snapshot.hasMore,
        };
    }
    cancel(requestId) {
        this.snapshots.cancel(requestId);
    }
    cancelActiveSnapshot() {
        this.snapshots.cancelActive();
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
