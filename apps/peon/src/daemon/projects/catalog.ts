import { randomUUID } from "node:crypto";
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

interface Snapshot {
  requestId: string;
  epoch: string;
  revision: number;
  barrierSeq: number;
  projects: ProjectCatalogProject[];
  offsets: Map<string, number>;
  nextCursors: Map<string, string | null>;
  expiresAt: number;
}

export interface ProjectCatalogSource {
  list(): ProjectRecord[];
  catalogState(): ProjectCatalogState;
  catalogEventsAfter(seq: number): ProjectCatalogEvent[] | null;
  acknowledgeProjectCatalog(seq: number): boolean;
  on(event: "catalog", listener: (event: ProjectCatalogEvent) => void): unknown;
}

export class ProjectCatalog {
  private snapshot: Snapshot | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly source: ProjectCatalogSource,
    private readonly now: () => number = Date.now,
  ) {}

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
    this.expireSnapshot();
    const limit = this.limit(rawLimit);
    if (!cursor) {
      if (this.snapshot && this.snapshot.requestId !== requestId) {
        throw new ProjectCatalogError("SYNC_IN_PROGRESS", "another project catalog snapshot is in progress");
      }
      if (!this.snapshot) {
        const projects: ProjectCatalogProject[] = [];
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
    if (offset === undefined) throw new ProjectCatalogError("BAD_CURSOR", "invalid project catalog cursor");

    const projects: ProjectCatalogProject[] = [];
    let pageBytes = 0;
    for (const project of snapshot.projects.slice(offset, offset + limit)) {
      const projectBytes = Buffer.byteLength(JSON.stringify(project));
      if (projects.length > 0 && pageBytes + projectBytes > MAX_PROJECT_CATALOG_PAGE_BYTES) break;
      projects.push(project);
      pageBytes += projectBytes;
    }
    const nextOffset = offset + projects.length;
    const hasMore = nextOffset < snapshot.projects.length;
    const cachedCursor = snapshot.nextCursors.get(key);
    const nextCursor = cachedCursor === undefined ? (hasMore ? randomUUID() : null) : cachedCursor;
    if (cachedCursor === undefined) {
      snapshot.nextCursors.set(key, nextCursor);
      if (nextCursor) snapshot.offsets.set(nextCursor, nextOffset);
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

  cancel(requestId: string): void {
    if (this.snapshot?.requestId === requestId) this.clearSnapshot();
  }

  cancelActiveSnapshot(): void {
    this.clearSnapshot();
  }

  private limit(raw: unknown): number {
    if (raw === undefined) return DEFAULT_PROJECT_CATALOG_PAGE_LIMIT;
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      throw new ProjectCatalogError("BAD_REQUEST", "project catalog limit must be a positive integer");
    }
    return Math.min(raw as number, MAX_PROJECT_CATALOG_PAGE_LIMIT);
  }

  private expireSnapshot(): void {
    if (this.snapshot && this.snapshot.expiresAt <= this.now()) this.clearSnapshot();
  }

  private scheduleSnapshotExpiry(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.expireSnapshot();
      if (this.snapshot) this.scheduleSnapshotExpiry();
    }, PROJECT_CATALOG_SNAPSHOT_TTL_MS);
    this.snapshotTimer.unref();
  }

  private clearSnapshot(): void {
    this.snapshot = null;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
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
