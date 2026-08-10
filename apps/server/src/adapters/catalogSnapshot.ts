import { randomUUID } from "node:crypto";

export interface CatalogSnapshotLimits {
  maxPageItems: number;
  maxItems: number;
  maxPages: number;
  maxBytes: number;
}

export interface CatalogSnapshotPage<T> {
  epoch: string;
  revision: number;
  barrierSeq: number;
  hasMore: boolean;
  nextCursor: string | null;
  frameBytes: number;
  rawItems: readonly unknown[];
  parse: (raw: unknown) => T;
  identity: (item: T) => string;
}

export class CatalogSnapshotError extends Error {}

/** Shared bounded snapshot/barrier state for every Peon-owned catalog. */
export class CatalogSnapshot<T> {
  readonly requestId = randomUUID();
  readonly startedAt = Date.now();
  readonly items: T[] = [];
  epoch: string | null = null;
  revision: number | null = null;
  barrierSeq: number | null = null;
  private readonly itemIds = new Set<string>();
  private readonly cursors = new Set<string>();
  private pages = 0;
  private bytes = 0;

  constructor(
    readonly resource: string,
    private readonly expectedEpoch: string,
    private readonly limits: CatalogSnapshotLimits,
  ) {}

  append(page: CatalogSnapshotPage<T>): { complete: boolean; nextCursor: string | null } {
    this.pages += 1;
    if (this.pages > this.limits.maxPages) throw new CatalogSnapshotError(`${this.resource} snapshot page limit exceeded`);
    if (page.rawItems.length > this.limits.maxPageItems) throw new CatalogSnapshotError(`invalid ${this.resource} catalog snapshot page`);
    if (page.hasMore !== (page.nextCursor !== null)) throw new CatalogSnapshotError("snapshot pagination mismatch");
    if (this.epoch === null) {
      this.epoch = page.epoch;
      this.revision = page.revision;
      this.barrierSeq = page.barrierSeq;
    } else if (this.epoch !== page.epoch || this.revision !== page.revision || this.barrierSeq !== page.barrierSeq) {
      throw new CatalogSnapshotError(`${this.resource} snapshot epoch or barrier changed`);
    }
    if (page.epoch !== this.expectedEpoch) throw new CatalogSnapshotError(`${this.resource} snapshot catalog epoch mismatch`);
    this.bytes += page.frameBytes;
    if (this.bytes > this.limits.maxBytes) throw new CatalogSnapshotError(`${this.resource} snapshot byte limit exceeded`);
    if (this.items.length + page.rawItems.length > this.limits.maxItems) throw new CatalogSnapshotError(`${this.resource} snapshot item limit exceeded`);
    for (const raw of page.rawItems) {
      const item = page.parse(raw);
      const id = page.identity(item);
      if (this.itemIds.has(id)) throw new CatalogSnapshotError(`duplicate ${this.resource} in snapshot`);
      this.itemIds.add(id);
      this.items.push(item);
    }
    if (page.hasMore) {
      if (!page.nextCursor || this.cursors.has(page.nextCursor)) throw new CatalogSnapshotError(`duplicate ${this.resource} snapshot cursor`);
      this.cursors.add(page.nextCursor);
    }
    return { complete: !page.hasMore, nextCursor: page.nextCursor };
  }
}
