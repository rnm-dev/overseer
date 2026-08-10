import { CatalogSnapshotPager } from "../catalog/snapshotPager.js";
import {
  catalogProject,
  projectStore,
  type ProjectCatalogEvent,
  type ProjectCatalogProject,
  type ProjectCatalogState,
  type ProjectRecord,
} from "./state.js";

export const PROJECT_CATALOG_CAPABILITY = "project-catalog-v1";
export const MAX_PROJECT_CATALOG_PAGE_LIMIT = 200;
export const DEFAULT_PROJECT_CATALOG_PAGE_LIMIT = 50;
export const PROJECT_CATALOG_SNAPSHOT_TTL_MS = 30_000;
export const MAX_PROJECT_CATALOG_PAGE_BYTES = 48 * 1024;
export const MAX_PROJECT_CATALOG_SNAPSHOT_ROWS = 20_000;
export const MAX_PROJECT_CATALOG_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface ProjectCatalogPage {
  requestId: string;
  epoch: string;
  revision: number;
  barrierSeq: number;
  projects: ProjectCatalogProject[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ProjectCatalogSource {
  list(): ProjectRecord[];
  catalogState(): ProjectCatalogState;
  catalogEventsAfter(seq: number): ProjectCatalogEvent[] | null;
  acknowledgeProjectCatalog(seq: number): boolean;
  on(event: "catalog", listener: (event: ProjectCatalogEvent) => void): unknown;
}

export class ProjectCatalog {
  private readonly snapshots: CatalogSnapshotPager<ProjectCatalogProject>;

  constructor(
    readonly source: ProjectCatalogSource,
    now: () => number = Date.now,
  ) {
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

  state(): ProjectCatalogState {
    return this.source.catalogState();
  }

  subscribe(listener: (event: ProjectCatalogEvent) => void): () => void {
    this.source.on("catalog", listener);
    return () => {
      const emitter = this.source as ProjectCatalogSource & { off?: (event: string, listener: (...args: never[]) => void) => unknown };
      emitter.off?.("catalog", listener as (...args: never[]) => void);
    };
  }

  eventsAfter(seq: number): ProjectCatalogEvent[] | null {
    return this.source.catalogEventsAfter(seq);
  }

  acknowledge(seq: number): boolean {
    return this.source.acknowledgeProjectCatalog(seq);
  }

  page(requestId: string, rawLimit: unknown, cursor?: string): ProjectCatalogPage {
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

  cancel(requestId: string): void {
    this.snapshots.cancel(requestId);
  }

  cancelActiveSnapshot(): void {
    this.snapshots.cancelActive();
  }
}

export class ProjectCatalogError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "BAD_CURSOR" | "SYNC_IN_PROGRESS" | "SNAPSHOT_TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

export const projectCatalog = new ProjectCatalog(projectStore);
