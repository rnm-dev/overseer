import { randomUUID } from "node:crypto";
import { CatalogSnapshotPager } from "../catalog/snapshotPager.js";
import { sessions, type SessionRecord } from "./index.js";
import { toSessionSummary, type SessionSummary } from "./sessionSummary.js";

export const SESSION_CATALOG_CAPABILITY = "session-catalog-v1";
export const MAX_SESSION_CATALOG_EVENTS = 1_000;
export const MAX_SESSION_CATALOG_PAGE_LIMIT = 200;
export const DEFAULT_SESSION_CATALOG_PAGE_LIMIT = 50;
export const SESSION_CATALOG_SNAPSHOT_TTL_MS = 30_000;
export const MAX_SESSION_CATALOG_PAGE_BYTES = 48 * 1024;
export const MAX_SESSION_CATALOG_SNAPSHOT_ROWS = 20_000;
export const MAX_SESSION_CATALOG_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export type SessionCatalogEvent =
  | { seq: number; revision: number; session: SessionSummary }
  | { seq: number; revision: number; deletedSessionId: string };

export interface SessionCatalogState {
  epoch: string;
  revision: number;
  earliestSeq: number;
  latestSeq: number;
}

export interface SessionCatalogPage {
  requestId: string;
  epoch: string;
  revision: number;
  barrierSeq: number;
  sessions: SessionSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SessionCatalogSource {
  list(): SessionRecord[];
  on(event: "change", listener: (record: SessionRecord) => void): unknown;
  on(event: "delete", listener: (sessionId: string) => void): unknown;
}

export class SessionCatalog {
  readonly epoch = randomUUID();
  private revision = 0;
  private seq = 0;
  private journal: SessionCatalogEvent[] = [];
  private listeners = new Set<(event: SessionCatalogEvent) => void>();
  private readonly snapshots: CatalogSnapshotPager<SessionSummary>;
  private started = false;

  constructor(
    private readonly source: SessionCatalogSource,
    now: () => number = Date.now,
  ) {
    this.snapshots = new CatalogSnapshotPager({
      defaultPageLimit: DEFAULT_SESSION_CATALOG_PAGE_LIMIT,
      maxPageLimit: MAX_SESSION_CATALOG_PAGE_LIMIT,
      maxPageBytes: MAX_SESSION_CATALOG_PAGE_BYTES,
      maxSnapshotRows: MAX_SESSION_CATALOG_SNAPSHOT_ROWS,
      maxSnapshotBytes: MAX_SESSION_CATALOG_SNAPSHOT_BYTES,
      ttlMs: SESSION_CATALOG_SNAPSHOT_TTL_MS,
      state: () => this.state(),
      rows: () => this.source.list().map(toSessionSummary),
      error: (code, message) => new SessionCatalogError(code, message),
      messages: {
        unavailable: "session catalog snapshot is unavailable",
        invalidCursor: "invalid session catalog cursor",
        syncInProgress: "another session catalog snapshot is in progress",
        tooLarge: "session catalog snapshot exceeds Peon memory bounds",
        invalidLimit: "session catalog limit must be a positive integer",
      },
      now,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.on("change", (record) => this.append({ session: toSessionSummary(record) }));
    this.source.on("delete", (sessionId) => this.append({ deletedSessionId: sessionId }));
  }

  state(): SessionCatalogState {
    return {
      epoch: this.epoch,
      revision: this.revision,
      earliestSeq: this.journal[0]?.seq ?? this.seq + 1,
      latestSeq: this.seq,
    };
  }

  subscribe(listener: (event: SessionCatalogEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsAfter(seq: number): SessionCatalogEvent[] | null {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.seq) return null;
    const earliest = this.journal[0]?.seq ?? this.seq + 1;
    if (seq < earliest - 1) return null;
    return this.journal.filter((event) => event.seq > seq);
  }

  acknowledge(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.seq) return false;
    this.journal = this.journal.filter((event) => event.seq > seq);
    return true;
  }

  page(requestId: string, rawLimit: unknown, cursor?: string): SessionCatalogPage {
    const snapshot = this.snapshots.page(requestId, rawLimit, cursor);
    return {
      requestId: snapshot.requestId,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      barrierSeq: snapshot.barrierSeq,
      sessions: snapshot.rows,
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

  private append(value: { session: SessionSummary } | { deletedSessionId: string }): void {
    this.seq += 1;
    this.revision += 1;
    const event = { seq: this.seq, revision: this.revision, ...value } as SessionCatalogEvent;
    this.journal.push(event);
    if (this.journal.length > MAX_SESSION_CATALOG_EVENTS) {
      this.journal = this.journal.slice(-MAX_SESSION_CATALOG_EVENTS);
    }
    for (const listener of this.listeners) listener(event);
  }

}

export class SessionCatalogError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "BAD_CURSOR" | "SYNC_IN_PROGRESS" | "SNAPSHOT_TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

export const sessionCatalog = new SessionCatalog(sessions);
