import { randomUUID } from "node:crypto";
import { CatalogSnapshotPager } from "../catalog/snapshotPager.js";
import type { SignoffSummary } from "./service.js";

// `signoff-catalog-v1`: the durable projection Overseer keeps of this Peon's
// sign-off heads, for the sidebar tab, badges and pushes. Same model as
// `session-catalog-v1` (docs/resource-synchronization.md): an epoch that
// changes on restart, a per-epoch revision/seq journal, paged snapshots
// fenced by a barrier seq. Sign-offs are never deleted, so there is no
// tombstone event; an orphaned sign-off is an ordinary change.

export const SIGNOFF_CATALOG_CAPABILITY = "signoff-catalog-v1";
export const MAX_SIGNOFF_CATALOG_EVENTS = 1_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_PAGE_BYTES = 48 * 1024;
const MAX_SNAPSHOT_ROWS = 20_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 30_000;

export interface SignoffCatalogEvent {
  seq: number;
  revision: number;
  signoff: SignoffSummary;
}

export interface SignoffCatalogPage {
  requestId: string;
  epoch: string;
  revision: number;
  barrierSeq: number;
  signoffs: SignoffSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SignoffCatalogSource {
  list(): SignoffSummary[];
  subscribe(listener: (summary: SignoffSummary) => void): () => void;
}

export class SignoffCatalogError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "BAD_CURSOR" | "SYNC_IN_PROGRESS" | "SNAPSHOT_TOO_LARGE",
    message: string,
  ) {
    super(message);
  }
}

export class SignoffCatalog {
  readonly epoch = randomUUID();
  private revision = 0;
  private seq = 0;
  private journal: SignoffCatalogEvent[] = [];
  private readonly listeners = new Set<(event: SignoffCatalogEvent) => void>();
  private readonly snapshots: CatalogSnapshotPager<SignoffSummary>;
  private started = false;

  constructor(private readonly source: SignoffCatalogSource, now: () => number = Date.now) {
    this.snapshots = new CatalogSnapshotPager({
      defaultPageLimit: DEFAULT_PAGE_LIMIT,
      maxPageLimit: MAX_PAGE_LIMIT,
      maxPageBytes: MAX_PAGE_BYTES,
      maxSnapshotRows: MAX_SNAPSHOT_ROWS,
      maxSnapshotBytes: MAX_SNAPSHOT_BYTES,
      ttlMs: SNAPSHOT_TTL_MS,
      state: () => this.state(),
      rows: () => this.source.list(),
      error: (code, message) => new SignoffCatalogError(code, message),
      messages: {
        unavailable: "sign-off catalog snapshot is unavailable",
        invalidCursor: "invalid sign-off catalog cursor",
        syncInProgress: "another sign-off catalog snapshot is in progress",
        tooLarge: "sign-off catalog snapshot exceeds Peon memory bounds",
        invalidLimit: "sign-off catalog limit must be a positive integer",
      },
      now,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.subscribe((signoff) => this.append(signoff));
  }

  state() {
    return {
      epoch: this.epoch,
      revision: this.revision,
      earliestSeq: this.journal[0]?.seq ?? this.seq + 1,
      latestSeq: this.seq,
    };
  }

  subscribe(listener: (event: SignoffCatalogEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  eventsAfter(seq: number): SignoffCatalogEvent[] | null {
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

  page(requestId: string, rawLimit: unknown, cursor?: string): SignoffCatalogPage {
    const snapshot = this.snapshots.page(requestId, rawLimit, cursor);
    return {
      requestId: snapshot.requestId,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      barrierSeq: snapshot.barrierSeq,
      signoffs: snapshot.rows,
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

  private append(signoff: SignoffSummary): void {
    this.seq += 1;
    this.revision += 1;
    const event = { seq: this.seq, revision: this.revision, signoff };
    this.journal.push(event);
    if (this.journal.length > MAX_SIGNOFF_CATALOG_EVENTS) this.journal = this.journal.slice(-MAX_SIGNOFF_CATALOG_EVENTS);
    for (const listener of this.listeners) listener(event);
  }
}
