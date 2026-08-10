import { BoundedDiagnostics } from "./diagnostics.js";
import { DeterministicTransport, HarnessLimitError } from "./faultTransport.js";

export class ResourceProjectionHarnessError extends HarnessLimitError {}

export class ResourceProjectionHarness {
  constructor({ family, authority, maxItems = 10_000, transport, diagnostics } = {}) {
    if (!family || !["peon", "overseer"].includes(authority)) throw new ResourceProjectionHarnessError("INVALID_CONFIG", "family and authority are required");
    this.family = family; this.authority = authority; this.maxItems = maxItems;
    this.transport = transport ?? new DeterministicTransport();
    this.diagnostics = diagnostics ?? new BoundedDiagnostics();
    this.rows = new Map(); this.cursor = 0; this.freshness = "offline";
  }
  connect() { this.freshness = "syncing"; return this.transport.generation; }
  replace(rows, cursor, generation = this.transport.generation) {
    if (generation !== this.transport.generation) return false;
    if (!Array.isArray(rows) || rows.length > this.maxItems) throw new ResourceProjectionHarnessError("SNAPSHOT_TOO_LARGE", "resource snapshot exceeds bounds");
    const next = new Map();
    for (const row of rows) {
      if (!row?.identity || !Number.isFinite(row.version) || next.has(row.identity)) throw new ResourceProjectionHarnessError("CORRUPT_SNAPSHOT", "resource snapshot is invalid");
      next.set(row.identity, structuredClone(row));
    }
    this.rows = next; this.cursor = cursor; this.freshness = "fresh"; return true;
  }
  apply(event, generation = this.transport.generation, { crashBeforeCommit = false } = {}) {
    if (generation !== this.transport.generation) return false;
    if (event.cursor > this.cursor + 1) { this.freshness = "stale"; this.diagnostics.add("resource_resync_required", { family: this.family, reason: "gap" }); throw new ResourceProjectionHarnessError("CURSOR_GAP", "resource cursor gap"); }
    if (event.cursor <= this.cursor) return true;
    if (crashBeforeCommit) return false;
    const previous = this.rows.get(event.identity);
    if (!previous || event.version >= previous.version) {
      if (event.deleted) this.rows.delete(event.identity);
      else this.rows.set(event.identity, structuredClone(event));
    }
    this.cursor = event.cursor; return true;
  }
  disconnect() { this.freshness = "offline"; }
  restart(side) { this.transport.restart(side); this.freshness = "stale"; }
  state() { return { family: this.family, authority: this.authority, freshness: this.freshness, cursor: this.cursor, rows: this.rows.size }; }
}
