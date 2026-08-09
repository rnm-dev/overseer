import { BoundedDiagnostics } from "./diagnostics.js";
import { DeterministicTransport, HarnessLimitError } from "./faultTransport.js";

export class SessionCatalogHarnessError extends HarnessLimitError {}

export class SessionCatalogHarness {
  constructor(options = {}) {
    this.transport = options.transport ?? new DeterministicTransport(options);
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.maxItems = options.maxItems ?? 10_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.projection = new Map();
    this.inbox = new Map();
    this.effects = new Set();
    this.acked = new Set();
    this.snapshot = null;
    this.freshness = "offline";
  }

  beginSnapshot(requestId = "catalog-fixture") {
    this.snapshot = { requestId, generation: this.transport.generation, epoch: null, barrier: null, items: new Map(), bytes: 0 };
    this.freshness = "syncing";
    return { type: "session_catalog_snapshot_request", requestId, limit: 100 };
  }

  receivePage(page, generation = this.transport.generation) {
    const stage = this.snapshot;
    if (!stage || stage.requestId !== page.requestId || stage.generation !== generation || generation !== this.transport.generation) return false;
    stage.bytes += Buffer.byteLength(JSON.stringify(page));
    if (!Array.isArray(page.sessions)) throw new SessionCatalogHarnessError("CORRUPT_SNAPSHOT", "sessions must be an array");
    if (stage.bytes > this.maxBytes || stage.items.size + page.sessions.length > this.maxItems) throw new SessionCatalogHarnessError("SNAPSHOT_TOO_LARGE", "session catalog snapshot exceeds bounds");
    if (stage.epoch === null) { stage.epoch = page.epoch; stage.barrier = page.barrierSeq; }
    if (stage.epoch !== page.epoch || stage.barrier !== page.barrierSeq || page.revision !== page.barrierSeq) throw new SessionCatalogHarnessError("CORRUPT_SNAPSHOT", "snapshot fence changed");
    for (const session of page.sessions) {
      if (!session?.id || stage.items.has(session.id)) throw new SessionCatalogHarnessError("CORRUPT_SNAPSHOT", "duplicate or invalid session");
      stage.items.set(session.id, structuredClone(session));
    }
    if (page.hasMore) return false;
    this.projection = stage.items;
    this.epoch = stage.epoch;
    this.seq = stage.barrier;
    this.snapshot = null;
    this.freshness = "fresh";
    return true;
  }

  commit(message, generation = this.transport.generation, options = {}) {
    if (generation !== this.transport.generation) return false;
    const event = message.payload;
    const identity = `${message.epoch}:${message.cursor}:${message.messageId}`;
    const body = canonical(event);
    if (this.inbox.has(identity)) {
      if (this.inbox.get(identity) !== body) throw new SessionCatalogHarnessError("REPLAY_MISMATCH", "durable identity payload changed");
      if (!options.crashAfterCommit) this.acked.add(identity);
      return true;
    }
    if (event.catalogEpoch !== this.epoch) return this.#resync("epoch", "EPOCH_MISMATCH");
    if (event.seq > this.seq + 1) return this.#resync("gap", "CATALOG_GAP");
    if (options.crashBeforeCommit) return false;
    if (event.seq <= this.seq) {
      const covered = event.operation === "delete"
        ? !this.projection.has(event.sessionId)
        : event.operation === "upsert" && event.session?.id && canonical(this.projection.get(event.session.id)) === canonical(event.session);
      if (!covered) throw new SessionCatalogHarnessError("REPLAY_MISMATCH", "snapshot-covered catalog event differs from projection");
    } else {
      if (event.operation === "delete") this.projection.delete(event.sessionId);
      else if (event.operation === "upsert" && event.session?.id) this.projection.set(event.session.id, structuredClone(event.session));
      else throw new SessionCatalogHarnessError("PROTOCOL_ERROR", "invalid catalog operation");
      this.seq = event.seq;
      this.effects.add(`${event.catalogEpoch}:${event.seq}`);
    }
    this.inbox.set(identity, body);
    if (!options.crashAfterCommit) this.acked.add(identity);
    return true;
  }

  restart(side) { this.transport.restart(side); this.snapshot = null; this.freshness = "stale"; }
  state() { return { freshness: this.freshness, epoch: this.epoch ?? null, seq: this.seq ?? null, sessions: this.projection.size, inbox: this.inbox.size, effects: this.effects.size, acked: this.acked.size }; }
  #resync(reason, code) { this.freshness = reason === "gap" ? "gap" : "syncing"; this.diagnostics.add("session_catalog_resync_required", { reason }); throw new SessionCatalogHarnessError(code, `session catalog ${reason}`); }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
