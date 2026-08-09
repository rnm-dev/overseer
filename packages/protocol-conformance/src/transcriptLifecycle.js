import { BoundedDiagnostics } from "./diagnostics.js";
import { DeterministicTransport, HarnessLimitError } from "./faultTransport.js";

export class TranscriptHarnessError extends HarnessLimitError {}

export class TranscriptSyncHarness {
  constructor(options = {}) {
    this.transport = options.transport ?? new DeterministicTransport(options);
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.maxEvents = options.maxEvents ?? 20_000;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.demands = new Map();
    this.snapshots = new Map();
    this.projections = new Map();
    this.inbox = new Set();
    this.browserEvents = new Set();
    this.acknowledged = new Set();
    this.deliveryPayloads = new Map();
    this.freshness = new Map();
  }

  acquire(sessionId) {
    const count = this.demands.get(sessionId) ?? 0;
    this.demands.set(sessionId, count + 1);
    if (count > 0) return null;
    const requestId = `00000000-0000-4000-8000-${String(this.demands.size).padStart(12, "0")}`;
    this.snapshots.set(sessionId, {
      requestId, generation: this.transport.generation, epoch: null, barrier: null,
      events: [], ids: new Set(), bytes: 0,
    });
    this.freshness.set(sessionId, "syncing");
    return { type: "transcript_snapshot_request", requestId, sessionId, limit: 100, subscribe: true };
  }

  release(sessionId) {
    const count = this.demands.get(sessionId) ?? 0;
    if (count > 1) {
      this.demands.set(sessionId, count - 1);
      return null;
    }
    this.demands.delete(sessionId);
    const snapshot = this.snapshots.get(sessionId);
    this.snapshots.delete(sessionId);
    return snapshot
      ? { type: "transcript_snapshot_cancel", requestId: snapshot.requestId, sessionId }
      : { type: "transcript_unsubscribe", requestId: "00000000-0000-4000-8000-000000000199", sessionId };
  }

  receiveSnapshot(page, envelopeGeneration = this.transport.generation) {
    const stage = this.snapshots.get(page.sessionId);
    if (!stage || stage.requestId !== page.requestId || stage.generation !== envelopeGeneration
      || envelopeGeneration !== this.transport.generation) return false;
    const bytes = Buffer.byteLength(JSON.stringify(page));
    stage.bytes += bytes;
    if (stage.bytes > this.maxBytes || !Array.isArray(page.events)
      || stage.events.length + page.events.length > this.maxEvents) {
      throw new TranscriptHarnessError("SNAPSHOT_TOO_LARGE", "transcript snapshot exceeds bounds");
    }
    if (page.revision !== page.barrierSeq) throw new TranscriptHarnessError("CORRUPT_SNAPSHOT", "revision/barrier mismatch");
    if (stage.epoch === null) {
      stage.epoch = page.epoch;
      stage.barrier = page.barrierSeq;
    } else if (stage.epoch !== page.epoch || stage.barrier !== page.barrierSeq) {
      throw new TranscriptHarnessError("CORRUPT_SNAPSHOT", "snapshot barrier changed");
    }
    for (const event of page.events) {
      const expected = stage.events.length + 1;
      if (event.sessionId !== page.sessionId || event.epoch !== page.epoch || event.seq !== expected
        || event.revision !== event.seq || stage.ids.has(event.eventId)) {
        throw new TranscriptHarnessError("CORRUPT_SNAPSHOT", "snapshot is sparse, reordered, or duplicated");
      }
      stage.ids.add(event.eventId);
      stage.events.push(structuredClone(event));
    }
    if (page.hasMore) return false;
    if (stage.events.length !== page.barrierSeq) throw new TranscriptHarnessError("CORRUPT_SNAPSHOT", "snapshot barrier is incomplete");
    this.projections.set(page.sessionId, {
      epoch: page.epoch, seq: page.barrierSeq, generation: this.transport.generation,
      events: stage.events,
    });
    this.freshness.set(page.sessionId, "fresh");
    this.snapshots.delete(page.sessionId);
    return true;
  }

  commitDurable(message, envelopeGeneration = this.transport.generation, options = {}) {
    if (envelopeGeneration !== this.transport.generation) return false;
    const event = message.payload;
    const projection = this.projections.get(event.sessionId);
    const identity = `${message.epoch}:${message.cursor}:${message.messageId}`;
    const canonicalPayload = canonicalJson(event);
    if (this.inbox.has(identity)) {
      if (this.deliveryPayloads.get(identity) !== canonicalPayload) {
        this.diagnostics.add("transcript_replay_mismatch", { sessionId: event.sessionId, cursor: message.cursor });
        throw new TranscriptHarnessError("REPLAY_MISMATCH", "durable identity payload changed");
      }
      return true;
    }
    if (!projection || projection.epoch !== event.epoch) {
      this.#requireResync(event.sessionId, "epoch");
      throw new TranscriptHarnessError("EPOCH_MISMATCH", "transcript epoch mismatch");
    }
    if (event.type === "transcript_deleted") {
      if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
        throw new TranscriptHarnessError("PROTOCOL_ERROR", "invalid transcript deletion revision");
      }
      if (options.crashBeforeCommit) return false;
      projection.events = [];
      projection.deleted = true;
      projection.seq = 0;
      this.inbox.add(identity);
      this.deliveryPayloads.set(identity, canonicalPayload);
      this.browserEvents.add(`deleted:${event.sessionId}:${event.epoch}:${event.revision}`);
      if (!options.crashAfterCommit) this.acknowledged.add(identity);
      return true;
    }
    if (event.seq <= projection.seq) {
      const projected = projection.events[event.seq - 1];
      if (!projected || projected.eventId !== event.eventId || canonicalJson(projected) !== canonicalPayload) {
        throw new TranscriptHarnessError("REPLAY_MISMATCH", "covered durable event differs from snapshot");
      }
      this.inbox.add(identity);
      this.deliveryPayloads.set(identity, canonicalPayload);
      if (!options.crashAfterCommit) this.acknowledged.add(identity);
      return true;
    }
    if (event.seq !== projection.seq + 1 || event.revision !== event.seq) {
      this.#requireResync(event.sessionId, "gap");
      throw new TranscriptHarnessError("TRANSCRIPT_GAP", "transcript sequence gap");
    }
    if (options.crashBeforeCommit) return false;
    // One synchronous boundary represents projection + inbox + ACL event-log commit.
    projection.events.push(structuredClone(event));
    projection.seq = event.seq;
    this.inbox.add(identity);
    this.deliveryPayloads.set(identity, canonicalPayload);
    this.browserEvents.add(event.eventId);
    if (options.crashAfterCommit) return true;
    this.acknowledged.add(identity);
    return true;
  }

  acknowledgeReplay(message) {
    const identity = `${message.epoch}:${message.cursor}:${message.messageId}`;
    if (!this.inbox.has(identity)) return false;
    if (this.deliveryPayloads.get(identity) !== canonicalJson(message.payload)) {
      throw new TranscriptHarnessError("REPLAY_MISMATCH", "durable identity payload changed");
    }
    this.acknowledged.add(identity);
    return true;
  }

  restart(side) {
    this.transport.restart(side);
    this.snapshots.clear();
    for (const projection of this.projections.values()) projection.generation = this.transport.generation;
    this.diagnostics.add("transcript_state_restored", {
      side, sessions: this.projections.size, inbox: this.inbox.size,
    });
  }

  syncFailure(sessionId, code) {
    if (!new Set(["CURSOR_UNAVAILABLE", "RESYNC_REQUIRED"]).has(code)) {
      throw new TranscriptHarnessError("PROTOCOL_ERROR", `unsupported sync failure ${code}`);
    }
    this.#requireResync(sessionId, code);
    if (!this.demands.has(sessionId)) this.demands.set(sessionId, 1);
    return this.#replaceSnapshot(sessionId);
  }

  evict(sessionId) {
    this.projections.delete(sessionId);
    this.freshness.set(sessionId, "evicted");
    this.diagnostics.add("transcript_projection_evicted", { sessionId });
  }

  state(sessionId) {
    const projection = this.projections.get(sessionId);
    return {
      freshness: this.freshness.get(sessionId) ?? "absent",
      epoch: projection?.epoch ?? null,
      seq: projection?.seq ?? null,
      effects: projection?.events.length ?? 0,
      deleted: projection?.deleted === true,
      inbox: this.inbox.size,
      acknowledged: this.acknowledged.size,
      browserEffects: this.browserEvents.size,
    };
  }

  #requireResync(sessionId, reason) {
    this.freshness.set(sessionId, reason === "gap" ? "gap" : "syncing");
    this.diagnostics.add("transcript_resync_required", { sessionId, reason });
  }

  #replaceSnapshot(sessionId) {
    this.snapshots.delete(sessionId);
    const requestId = `00000000-0000-4000-8000-${String(this.demands.size + this.inbox.size + 200).padStart(12, "0")}`;
    this.snapshots.set(sessionId, {
      requestId, generation: this.transport.generation, epoch: null, barrier: null,
      events: [], ids: new Set(), bytes: 0,
    });
    return { type: "transcript_snapshot_request", requestId, sessionId, limit: 100, subscribe: true };
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
