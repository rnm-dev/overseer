export interface PreviewLease {
  leaseId: string;
  key: string;
  expiresAt: number;
}

interface LogicalWatch {
  revision: number;
  activatedRevision: number;
  leases: Map<string, PreviewLease>;
}

export interface PreviewRevision {
  key: string;
  revision: number;
}

/**
 * Transport-independent state for advanced preview watches.
 *
 * Filesystem watchers and transfer streams deliberately live outside this
 * class. Keeping lease sharing and revision fencing here makes reconnect and
 * slow-transfer races deterministic without creating a second file transport.
 */
export class PreviewRevisionState {
  private readonly watches = new Map<string, LogicalWatch>();
  private readonly leaseKeys = new Map<string, string>();
  private revisionHighWater: number;

  constructor(
    private readonly maxLogicalWatches = 16,
    private readonly maxLeases = 64,
    revisionFloor = 0,
  ) {
    if (!Number.isSafeInteger(maxLogicalWatches) || maxLogicalWatches < 1) {
      throw new RangeError("maxLogicalWatches must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxLeases) || maxLeases < 1) {
      throw new RangeError("maxLeases must be a positive safe integer");
    }
    if (!Number.isSafeInteger(revisionFloor) || revisionFloor < 0) {
      throw new RangeError("revisionFloor must be a non-negative safe integer");
    }
    this.revisionHighWater = revisionFloor;
  }

  add(lease: PreviewLease): { shared: boolean } {
    this.validateLease(lease);
    if (this.leaseKeys.has(lease.leaseId)) throw new Error("DUPLICATE_LEASE");
    if (this.leaseKeys.size >= this.maxLeases) throw new Error("LEASE_LIMIT");

    let watch = this.watches.get(lease.key);
    const shared = watch !== undefined;
    if (!watch) {
      if (this.watches.size >= this.maxLogicalWatches) throw new Error("WATCH_LIMIT");
      watch = { revision: 0, activatedRevision: 0, leases: new Map() };
      this.watches.set(lease.key, watch);
    }
    const stored = { ...lease };
    watch.leases.set(lease.leaseId, stored);
    this.leaseKeys.set(lease.leaseId, lease.key);
    return { shared };
  }

  renew(leaseId: string, expiresAt: number): boolean {
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) throw new Error("INVALID_EXPIRY");
    const key = this.leaseKeys.get(leaseId);
    if (!key) return false;
    const lease = this.watches.get(key)?.leases.get(leaseId);
    if (!lease) return false;
    // A delayed/replayed renewal must not undo a newer extension.
    lease.expiresAt = Math.max(lease.expiresAt, expiresAt);
    return true;
  }

  remove(leaseId: string): { removed: boolean; watchReleased: boolean } {
    const key = this.leaseKeys.get(leaseId);
    if (!key) return { removed: false, watchReleased: false };
    this.leaseKeys.delete(leaseId);
    const watch = this.watches.get(key);
    if (!watch) return { removed: true, watchReleased: false };
    watch.leases.delete(leaseId);
    if (watch.leases.size > 0) return { removed: true, watchReleased: false };
    this.watches.delete(key);
    return { removed: true, watchReleased: true };
  }

  expire(now: number): string[] {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_TIME");
    const released: string[] = [];
    for (const [leaseId, key] of [...this.leaseKeys]) {
      const lease = this.watches.get(key)?.leases.get(leaseId);
      if (lease && lease.expiresAt > now) continue;
      if (this.remove(leaseId).watchReleased) released.push(key);
    }
    return released;
  }

  begin(key: string): PreviewRevision {
    const watch = this.watches.get(key);
    if (!watch) throw new Error("UNKNOWN_WATCH");
    if (this.revisionHighWater >= Number.MAX_SAFE_INTEGER) throw new Error("REVISION_EXHAUSTED");
    this.revisionHighWater += 1;
    watch.revision = this.revisionHighWater;
    return { key, revision: watch.revision };
  }

  /**
   * Advances the allocator after daemon restart reconciliation. Replayed or
   * stale floors are harmless; callers can safely apply the Overseer-committed
   * high-water revision more than once.
   */
  reconcileRevisionFloor(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("INVALID_REVISION");
    this.revisionHighWater = Math.max(this.revisionHighWater, revision);
  }

  activate(candidate: PreviewRevision): boolean {
    const watch = this.watches.get(candidate.key);
    if (!watch) return false;
    if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) return false;
    if (candidate.revision !== watch.revision) return false;
    if (candidate.revision <= watch.activatedRevision) return false;
    watch.activatedRevision = candidate.revision;
    return true;
  }

  snapshot(): Array<{ key: string; revision: number; activatedRevision: number; leases: PreviewLease[] }> {
    return [...this.watches].map(([key, watch]) => ({
      key,
      revision: watch.revision,
      activatedRevision: watch.activatedRevision,
      leases: [...watch.leases.values()].map((lease) => ({ ...lease })),
    }));
  }

  clear(): string[] {
    const keys = [...this.watches.keys()];
    this.watches.clear();
    this.leaseKeys.clear();
    return keys;
  }

  private validateLease(lease: PreviewLease): void {
    if (!lease.leaseId || lease.leaseId.length > 128) throw new Error("INVALID_LEASE_ID");
    if (!lease.key || lease.key.length > 4608) throw new Error("INVALID_WATCH_KEY");
    if (!Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0) throw new Error("INVALID_EXPIRY");
  }
}
