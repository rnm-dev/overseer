import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import type { PeonRecord } from "./registry.js";
import {
  claimTranscriptGeneration,
  commitSnapshotCoveredTranscriptEvent,
  commitTranscriptDeletion,
  commitTranscriptEvent,
  commitTranscriptSnapshot,
  getTranscriptState,
  markTranscriptSyncState,
  pruneTranscriptProjection,
  releaseTranscriptGeneration,
  TranscriptProjectionError,
  TRANSCRIPT_SESSION_BYTE_LIMIT,
  TRANSCRIPT_SESSION_EVENT_LIMIT,
  type TranscriptDeliveryCheckpoint,
  type TranscriptEnvelope,
} from "./modules/sessions/index.js";

export const SESSION_TRANSCRIPT_CAPABILITY = "transcript-sync-v1";

const PAGE_LIMIT = 100;
const MAX_PAGE_EVENTS = 250;
const MAX_SNAPSHOT_PAGES = 1_000;
const MAX_ACTIVE_SNAPSHOTS = 4;
const SNAPSHOT_TIMEOUT_MS = 60_000;
const READY_WAIT_MS = 15_000;
export const MAX_TRANSCRIPT_SUBSCRIPTIONS = 64;

export const TRANSCRIPT_CHANNEL_HELLO = {
  snapshotPageEvents: 100,
  snapshotPageBytes: 768 * 1024,
  snapshotEvents: TRANSCRIPT_SESSION_EVENT_LIMIT,
  snapshotBytes: TRANSCRIPT_SESSION_BYTE_LIMIT,
  activeSnapshots: MAX_ACTIVE_SNAPSHOTS,
  subscriptions: MAX_TRANSCRIPT_SUBSCRIPTIONS,
  subscriptionTtlMs: 5 * 60_000,
  eventBytes: 192 * 1024,
} as const;

export function validTranscriptChannelHello(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const channel = value as Record<string, unknown>;
  return Object.entries(TRANSCRIPT_CHANNEL_HELLO)
    .every(([key, expected]) => channel[key] === expected);
}

export interface DurableTranscriptEvent {
  channel: "transcript";
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  sessionId: string;
  transcriptEpoch: string;
  seq: number;
  revision: number;
  eventId: string;
  event: Record<string, unknown>;
}

export interface DurableTranscriptDeletion {
  channel: "transcript";
  deleted: true;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  sessionId: string;
  transcriptEpoch: string;
  revision: number;
}

export type DurableTranscriptMessage = DurableTranscriptEvent | DurableTranscriptDeletion;

interface SnapshotState {
  requestId: string;
  sessionId: string;
  epoch: string | null;
  revision: number | null;
  barrierSeq: number | null;
  events: TranscriptEnvelope[];
  eventIds: Set<string>;
  seenCursors: Set<string>;
  pages: number;
  bytes: number;
  requiredForDelivery: boolean;
  timer: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const active = new Map<string, PeonTranscriptSync>();
export const transcriptConnectionBus = new EventEmitter();
transcriptConnectionBus.setMaxListeners(0);

export function hasReverseTranscriptConnection(peonId: string): boolean {
  return active.get(peonId)?.connected === true;
}

export async function acquireTranscriptProjection(
  peonId: string,
  sessionId: string,
): Promise<() => void> {
  const sync = active.get(peonId);
  if (!sync?.connected) throw new Error("reverse transcript connection unavailable");
  return sync.acquire(sessionId);
}

export class PeonTranscriptSync {
  private readonly snapshots = new Map<string, SnapshotState>();
  private readonly demands = new Map<string, number>();
  private readonly claimed = new Set<string>();
  private readonly waiters = new Map<string, Set<ReadyWaiter>>();
  private readonly subscriptionRequests = new Map<string, {
    sessionId: string;
    epoch: string;
    afterSeq: number;
    timer: NodeJS.Timeout;
  }>();
  private readonly readySessions = new Set<string>();
  private readonly renewalTimers = new Map<string, NodeJS.Timeout>();
  private readonly subscriptions = new Set<string>();
  private disposed = false;

  constructor(
    private readonly record: PeonRecord,
    private readonly ws: WebSocket,
    readonly generation: string,
    private readonly options: {
      readyWaitMs?: number;
      subscriptionResponseMs?: number;
      subscriptionLimit?: number;
      loadTranscriptState?: typeof getTranscriptState;
      scheduleRenewal?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
      scheduleSubscriptionTimeout?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    } = {},
  ) {}

  get connected(): boolean {
    return !this.disposed && this.ws.readyState === WebSocket.OPEN && active.get(this.record.peonId) === this;
  }

  start(): void {
    const previous = active.get(this.record.peonId);
    active.set(this.record.peonId, this);
    if (previous && previous !== this) previous.dispose();
    transcriptConnectionBus.emit("changed", this.record.peonId, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (active.get(this.record.peonId) === this) {
      active.delete(this.record.peonId);
      transcriptConnectionBus.emit("changed", this.record.peonId, false);
    }
    for (const snapshot of this.snapshots.values()) clearTimeout(snapshot.timer);
    this.snapshots.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("reverse transcript connection closed"));
      }
    }
    this.waiters.clear();
    this.demands.clear();
    this.claimed.clear();
    this.readySessions.clear();
    for (const request of this.subscriptionRequests.values()) clearTimeout(request.timer);
    this.subscriptionRequests.clear();
    this.subscriptions.clear();
    for (const timer of this.renewalTimers.values()) clearTimeout(timer);
    this.renewalTimers.clear();
    void releaseTranscriptGeneration(this.record.peonId, this.generation).catch(() => undefined);
  }

  hasActiveSnapshots(): boolean {
    return this.snapshots.size > 0;
  }

  subscriptionStats(): { activeOrPending: number; pendingResponses: number } {
    return {
      activeOrPending: this.subscriptions.size,
      pendingResponses: this.subscriptionRequests.size,
    };
  }

  async acquire(sessionId: string): Promise<() => void> {
    const bounded = requiredString(sessionId, "sessionId", 512);
    const demand = this.demands.get(bounded) ?? 0;
    if (demand === 0) this.reserveSubscription(bounded);
    this.demands.set(bounded, demand + 1);
    try {
      if (demand > 0) {
        if (!this.readySessions.has(bounded)) await this.waitUntilReady(bounded);
        let sharedReleased = false;
        return () => {
          if (sharedReleased) return;
          sharedReleased = true;
          this.release(bounded);
        };
      }
      const state = await this.ensureClaimed(bounded);
      if (!state.epoch
        || state.acknowledgedSeq === null
        || state.status === "evicted"
        || state.status === "gap") {
        this.requestSnapshot(bounded, false);
        await this.waitUntilReady(bounded);
      } else {
        const ready = this.waitUntilReady(bounded);
        const requestId = this.beginSubscription(
          bounded,
          state.epoch,
          state.acknowledgedSeq,
        );
        this.send({
          type: "transcript_subscribe",
          requestId,
          sessionId: bounded,
          epoch: state.epoch,
          afterSeq: state.acknowledgedSeq,
        });
        await ready;
      }
    } catch (error) {
      this.release(bounded);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(bounded);
    };
  }

  async prepareDurable(event: DurableTranscriptMessage): Promise<boolean> {
    const state = await this.ensureClaimed(event.sessionId);
    if ("deleted" in event) return true;
    if (!state.epoch
      || state.status === "evicted"
      || state.epoch !== event.transcriptEpoch
      || state.acknowledgedSeq === null
      || event.seq > state.acknowledgedSeq + 1) {
      await markTranscriptSyncState({
        peonId: this.record.peonId,
        sessionId: event.sessionId,
        generation: this.generation,
        status: state.epoch ? "gap" : "syncing",
      });
      this.requestSnapshot(event.sessionId, true);
      return false;
    }
    return true;
  }

  async commitDurable(event: DurableTranscriptMessage): Promise<TranscriptDeliveryCheckpoint> {
    if ("deleted" in event) {
      return commitTranscriptDeletion({
        workspaceId: this.record.workspaceId,
        peonId: this.record.peonId,
        sessionId: event.sessionId,
        generation: this.generation,
        transcriptEpoch: event.transcriptEpoch,
        deliveryEpoch: event.deliveryEpoch,
        deliveryCursor: event.deliveryCursor,
        messageId: event.messageId,
      });
    }
    const state = await getTranscriptState(this.record.peonId, event.sessionId);
    if (!state?.epoch || state.acknowledgedSeq === null) {
      throw new TranscriptProjectionError("TRANSCRIPT_NOT_READY", "transcript event arrived before snapshot");
    }
    if (state.epoch !== event.transcriptEpoch || event.seq <= state.acknowledgedSeq) {
      return commitSnapshotCoveredTranscriptEvent({
        peonId: this.record.peonId,
        sessionId: event.sessionId,
        generation: this.generation,
        transcriptEpoch: event.transcriptEpoch,
        seq: event.seq,
        eventId: event.eventId,
        event: event.event,
        deliveryEpoch: event.deliveryEpoch,
        deliveryCursor: event.deliveryCursor,
        messageId: event.messageId,
      });
    }
    return commitTranscriptEvent({
      workspaceId: this.record.workspaceId,
      peonId: this.record.peonId,
      sessionId: event.sessionId,
      generation: this.generation,
      transcriptEpoch: event.transcriptEpoch,
      seq: event.seq,
      revision: event.revision,
      eventId: event.eventId,
      event: event.event,
      deliveryEpoch: event.deliveryEpoch,
      deliveryCursor: event.deliveryCursor,
      messageId: event.messageId,
    });
  }

  parseDurable(message: Record<string, unknown>): DurableTranscriptMessage | null {
    if (!message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)) return null;
    const payload = message.payload as Record<string, unknown>;
    if (payload.type !== "transcript_live_event" && payload.type !== "transcript_deleted") return null;
    if (!(["critical", "control", "normal", "bulk"] as unknown[]).includes(message.priority)) {
      throw new Error("invalid durable priority");
    }
    if (message.capability !== SESSION_TRANSCRIPT_CAPABILITY) throw new Error("invalid transcript durable capability");
    const base = {
      channel: "transcript" as const,
      deliveryEpoch: requiredString(message.epoch, "epoch", 256),
      deliveryCursor: requiredString(message.cursor, "cursor", 2_000),
      messageId: requiredUuid(message.messageId, "messageId"),
      sessionId: requiredString(payload.sessionId, "sessionId", 512),
      transcriptEpoch: requiredString(payload.epoch, "transcript epoch", 256),
      revision: requiredSequence(payload.revision, "transcript revision"),
    };
    if (payload.type === "transcript_deleted") return { ...base, deleted: true };
    if (!payload.event || typeof payload.event !== "object" || Array.isArray(payload.event)) throw new Error("invalid transcript event");
    return {
      ...base,
      seq: requiredSequence(payload.seq, "transcript seq"),
      eventId: requiredString(payload.eventId, "eventId", 512),
      event: publishedEventToBrowser(payload),
    };
  }

  async handle(message: Record<string, unknown>, frameBytes: number): Promise<boolean> {
    switch (message.type) {
      case "transcript_snapshot_page":
        await this.receiveSnapshotPage(message, frameBytes);
        return true;
      case "transcript_snapshot_cancelled": {
        const snapshot = this.findSnapshotByRequest(message);
        if (snapshot) this.failSnapshot(snapshot, new Error("transcript snapshot cancelled"));
        return true;
      }
      case "transcript_error":
        await this.receiveError(message);
        return true;
      case "transcript_subscribed":
        this.receiveSubscribed(message);
        return true;
      case "transcript_unsubscribed":
        this.subscriptionRequests.delete(requiredString(message.requestId, "requestId", 200));
        requiredString(message.sessionId, "sessionId", 512);
        return true;
      default:
        return false;
    }
  }

  private async ensureClaimed(sessionId: string) {
    const state = await claimTranscriptGeneration({
      workspaceId: this.record.workspaceId,
      peonId: this.record.peonId,
      sessionId,
      generation: this.generation,
    });
    this.claimed.add(sessionId);
    return state;
  }

  private release(sessionId: string): void {
    const next = (this.demands.get(sessionId) ?? 1) - 1;
    if (next > 0) {
      this.demands.set(sessionId, next);
      return;
    }
    this.demands.delete(sessionId);
    this.readySessions.delete(sessionId);
    this.clearPendingSubscriptions(sessionId);
    const renewal = this.renewalTimers.get(sessionId);
    if (renewal) clearTimeout(renewal);
    this.renewalTimers.delete(sessionId);
    if (this.subscriptions.delete(sessionId)) {
      this.send({ type: "transcript_unsubscribe", requestId: randomUUID(), sessionId });
    }
    const snapshot = this.snapshots.get(sessionId);
    if (snapshot && !snapshot.requiredForDelivery) {
      this.send({ type: "transcript_snapshot_cancel", requestId: snapshot.requestId, sessionId });
      this.failSnapshot(snapshot, new Error("transcript snapshot has no authorized consumer"));
    }
  }

  private requestSnapshot(sessionId: string, requiredForDelivery: boolean, cursor?: string): void {
    const alreadyReserved = this.subscriptions.has(sessionId);
    this.reserveSubscription(sessionId);
    let snapshot = this.snapshots.get(sessionId);
    if (!snapshot) {
      if (this.snapshots.size >= MAX_ACTIVE_SNAPSHOTS) {
        if (!alreadyReserved) this.subscriptions.delete(sessionId);
        throw new Error("too many active transcript snapshots");
      }
      const timer = setTimeout(() => {
        const activeSnapshot = this.snapshots.get(sessionId);
        if (!activeSnapshot || this.disposed) return;
        this.send({ type: "transcript_snapshot_cancel", requestId: activeSnapshot.requestId, sessionId });
        this.failSnapshot(activeSnapshot, new Error("transcript sync timeout"));
        if (activeSnapshot.requiredForDelivery && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1011, "transcript sync timeout");
        }
      }, SNAPSHOT_TIMEOUT_MS);
      timer.unref();
      snapshot = {
        requestId: randomUUID(),
        sessionId,
        epoch: null,
        revision: null,
        barrierSeq: null,
        events: [],
        eventIds: new Set(),
        seenCursors: new Set(),
        pages: 0,
        bytes: 0,
        requiredForDelivery,
        timer,
      };
      this.snapshots.set(sessionId, snapshot);
    } else if (requiredForDelivery) {
      snapshot.requiredForDelivery = true;
    }
    const frame: Record<string, unknown> = {
      type: "transcript_snapshot_request",
      requestId: snapshot.requestId,
      sessionId,
      limit: PAGE_LIMIT,
      subscribe: true,
    };
    if (cursor !== undefined) frame.cursor = cursor;
    this.send(frame);
  }

  private async receiveSnapshotPage(message: Record<string, unknown>, frameBytes: number): Promise<void> {
    const snapshot = this.requireSnapshot(message);
    if (message.sessionId !== snapshot.sessionId) throw new Error("transcript snapshot session mismatch");
    snapshot.pages += 1;
    snapshot.bytes += frameBytes;
    if (snapshot.pages > MAX_SNAPSHOT_PAGES
      || snapshot.bytes > TRANSCRIPT_SESSION_BYTE_LIMIT
      || !Array.isArray(message.events)
      || message.events.length > MAX_PAGE_EVENTS) {
      throw new Error("transcript snapshot bounds exceeded");
    }
    const epoch = requiredString(message.epoch, "transcript epoch", 256);
    const revision = requiredSequence(message.revision, "transcript revision");
    const barrierSeq = requiredSequence(message.barrierSeq, "transcript barrier");
    if (revision !== barrierSeq) throw new Error("transcript snapshot revision mismatch");
    if (snapshot.epoch === null) {
      snapshot.epoch = epoch;
      snapshot.revision = revision;
      snapshot.barrierSeq = barrierSeq;
    } else if (snapshot.epoch !== epoch || snapshot.revision !== revision || snapshot.barrierSeq !== barrierSeq) {
      throw new Error("transcript snapshot barrier changed");
    }
    const page = message.events.map((event) =>
      parseSnapshotEnvelope(event, snapshot.sessionId, epoch));
    if (snapshot.events.length + page.length > TRANSCRIPT_SESSION_EVENT_LIMIT) {
      throw new Error("transcript snapshot event limit exceeded");
    }
    for (const envelope of page) {
      if (snapshot.eventIds.has(envelope.eventId)) throw new Error("duplicate transcript snapshot event");
      const previous = snapshot.events[snapshot.events.length - 1];
      if (previous && envelope.seq <= previous.seq) throw new Error("transcript snapshot sequence reordered");
      snapshot.eventIds.add(envelope.eventId);
      snapshot.events.push(envelope);
    }
    if (typeof message.hasMore !== "boolean") throw new Error("invalid transcript snapshot pagination");
    const nextCursor = optionalString(message.nextCursor, "nextCursor", 2_000);
    if (message.hasMore !== (nextCursor !== null)) throw new Error("transcript snapshot pagination mismatch");
    if (message.hasMore) {
      if (!nextCursor || snapshot.seenCursors.has(nextCursor)) throw new Error("duplicate transcript snapshot cursor");
      snapshot.seenCursors.add(nextCursor);
      this.requestSnapshot(snapshot.sessionId, snapshot.requiredForDelivery, nextCursor);
      return;
    }
    clearTimeout(snapshot.timer);
    await commitTranscriptSnapshot({
      workspaceId: this.record.workspaceId,
      peonId: this.record.peonId,
      sessionId: snapshot.sessionId,
      generation: this.generation,
      epoch,
      revision,
      barrierSeq,
      events: snapshot.events,
    });
    this.snapshots.delete(snapshot.sessionId);
    this.send({ type: "transcript_snapshot_cancel", requestId: snapshot.requestId });
    this.resolveReady(snapshot.sessionId);
    if ((this.demands.get(snapshot.sessionId) ?? 0) === 0) {
      this.readySessions.delete(snapshot.sessionId);
      this.clearPendingSubscriptions(snapshot.sessionId);
      if (this.subscriptions.delete(snapshot.sessionId)) {
        this.send({ type: "transcript_unsubscribe", requestId: randomUUID(), sessionId: snapshot.sessionId });
      }
    } else {
      this.scheduleRenewal(snapshot.sessionId, Date.now() + 5 * 60_000);
    }
    void pruneTranscriptProjection().catch(() => undefined);
  }

  private async receiveError(message: Record<string, unknown>): Promise<void> {
    const sessionId = requiredString(message.sessionId, "sessionId", 512);
    const code = requiredString(message.code, "code", 64);
    const snapshot = this.snapshots.get(sessionId);
    const requestId = typeof message.requestId === "string" ? message.requestId : null;
    if (requestId) {
      const subscription = this.subscriptionRequests.get(requestId);
      if (subscription) clearTimeout(subscription.timer);
      this.subscriptionRequests.delete(requestId);
    }
    if ((code === "CURSOR_UNAVAILABLE" || code === "RESYNC_REQUIRED") && (snapshot || (this.demands.get(sessionId) ?? 0) > 0)) {
      if (!snapshot) {
        await markTranscriptSyncState({
          peonId: this.record.peonId,
          sessionId,
          generation: this.generation,
          status: "gap",
        });
        this.requestSnapshot(sessionId, false);
        return;
      }
      this.send({ type: "transcript_snapshot_cancel", requestId: snapshot.requestId, sessionId });
      clearTimeout(snapshot.timer);
      this.snapshots.delete(sessionId);
      this.requestSnapshot(sessionId, snapshot.requiredForDelivery);
      return;
    }
    const error = new Error(`transcript error: ${code}`);
    if (snapshot) this.failSnapshot(snapshot, error);
    else this.rejectReady(sessionId, error);
  }

  private requireSnapshot(message: Record<string, unknown>): SnapshotState {
    const requestId = requiredString(message.requestId, "requestId", 64);
    const sessionId = requiredString(message.sessionId, "sessionId", 512);
    const snapshot = this.snapshots.get(sessionId);
    if (!snapshot || snapshot.requestId !== requestId) throw new Error("transcript snapshot request mismatch");
    return snapshot;
  }

  private findSnapshotByRequest(message: Record<string, unknown>): SnapshotState | null {
    const requestId = requiredString(message.requestId, "requestId", 200);
    const snapshot = [...this.snapshots.values()].find((candidate) => candidate.requestId === requestId);
    return snapshot ?? null;
  }

  private receiveSubscribed(message: Record<string, unknown>): void {
    const requestId = requiredString(message.requestId, "requestId", 200);
    const sessionId = requiredString(message.sessionId, "sessionId", 512);
    const expected = this.subscriptionRequests.get(requestId);
    if (!expected) {
      if (!this.subscriptions.has(sessionId)) return;
      throw new Error("transcript subscription request mismatch");
    }
    if (expected.sessionId !== sessionId) throw new Error("transcript subscription request mismatch");
    clearTimeout(expected.timer);
    this.subscriptionRequests.delete(requestId);
    if (requiredString(message.epoch, "transcript epoch", 256) !== expected.epoch
      || requiredSequence(message.afterSeq, "afterSeq") !== expected.afterSeq) {
      throw new Error("transcript subscription checkpoint mismatch");
    }
    const expiresAt = typeof message.expiresAt === "number" && Number.isFinite(message.expiresAt)
      ? message.expiresAt
      : Date.now() + 5 * 60_000;
    this.scheduleRenewal(sessionId, expiresAt);
    this.resolveReady(sessionId);
  }

  private scheduleRenewal(sessionId: string, expiresAt: number): void {
    const previous = this.renewalTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    if ((this.demands.get(sessionId) ?? 0) === 0 || this.disposed) {
      this.renewalTimers.delete(sessionId);
      return;
    }
    const schedule = this.options.scheduleRenewal ?? setTimeout;
    const timer = schedule(() => {
      this.renewalTimers.delete(sessionId);
      if ((this.demands.get(sessionId) ?? 0) === 0 || this.disposed) return;
      const loadState = this.options.loadTranscriptState ?? getTranscriptState;
      void loadState(this.record.peonId, sessionId).then((state) => {
        if ((this.demands.get(sessionId) ?? 0) === 0
          || !this.subscriptions.has(sessionId)
          || this.disposed) return;
        if (!state?.epoch || state.acknowledgedSeq === null) {
          this.requestSnapshot(sessionId, false);
          return;
        }
        const requestId = this.beginSubscription(
          sessionId,
          state.epoch,
          state.acknowledgedSeq,
        );
        this.send({
          type: "transcript_subscribe",
          requestId,
          sessionId,
          epoch: state.epoch,
          afterSeq: state.acknowledgedSeq,
        });
      }).catch(() => {
        if ((this.demands.get(sessionId) ?? 0) > 0
          && this.subscriptions.has(sessionId)
          && !this.disposed
          && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1011, "transcript renewal failed");
        }
      });
    }, Math.max(1_000, expiresAt - Date.now() - 30_000));
    timer.unref();
    this.renewalTimers.set(sessionId, timer);
  }

  private waitUntilReady(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(sessionId);
        if (waiters) {
          for (const waiter of waiters) {
            if (waiter.resolve === resolve) waiters.delete(waiter);
          }
          if (waiters.size === 0) this.waiters.delete(sessionId);
        }
        reject(new Error("transcript projection is still syncing"));
      }, this.options.readyWaitMs ?? READY_WAIT_MS);
      timer.unref();
      const waiter: ReadyWaiter = { resolve, reject, timer };
      const waiters = this.waiters.get(sessionId) ?? new Set<ReadyWaiter>();
      waiters.add(waiter);
      this.waiters.set(sessionId, waiters);
    });
  }

  private resolveReady(sessionId: string): void {
    this.readySessions.add(sessionId);
    const waiters = this.waiters.get(sessionId);
    if (!waiters) return;
    this.waiters.delete(sessionId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectReady(sessionId: string, error: Error): void {
    this.readySessions.delete(sessionId);
    const waiters = this.waiters.get(sessionId);
    if (!waiters) return;
    this.waiters.delete(sessionId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private failSnapshot(snapshot: SnapshotState, error: Error): void {
    clearTimeout(snapshot.timer);
    this.snapshots.delete(snapshot.sessionId);
    this.rejectReady(snapshot.sessionId, error);
  }

  private reserveSubscription(sessionId: string): void {
    if (this.subscriptions.has(sessionId)) return;
    const limit = this.options.subscriptionLimit ?? MAX_TRANSCRIPT_SUBSCRIPTIONS;
    if (this.subscriptions.size >= limit) {
      throw new Error("transcript subscription limit exceeded");
    }
    this.subscriptions.add(sessionId);
  }

  private clearPendingSubscriptions(sessionId: string): void {
    for (const [requestId, request] of this.subscriptionRequests) {
      if (request.sessionId !== sessionId) continue;
      clearTimeout(request.timer);
      this.subscriptionRequests.delete(requestId);
    }
  }

  private beginSubscription(sessionId: string, epoch: string, afterSeq: number): string {
    const requestId = randomUUID();
    const schedule = this.options.scheduleSubscriptionTimeout ?? setTimeout;
    const timer = schedule(() => {
      const current = this.subscriptionRequests.get(requestId);
      if (!current) return;
      this.subscriptionRequests.delete(requestId);
      this.rejectReady(sessionId, new Error("transcript subscription timed out"));
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1011, "transcript subscription timed out");
      this.dispose();
    }, this.options.subscriptionResponseMs ?? READY_WAIT_MS);
    timer.unref();
    this.subscriptionRequests.set(requestId, { sessionId, epoch, afterSeq, timer });
    return requestId;
  }

  private send(frame: Record<string, unknown>): void {
    if (this.disposed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }
}

function parseSnapshotEnvelope(
  value: unknown,
  expectedSessionId: string,
  expectedEpoch: string,
): TranscriptEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid transcript snapshot event");
  const envelope = value as Record<string, unknown>;
  if (!envelope.event || typeof envelope.event !== "object" || Array.isArray(envelope.event)) {
    throw new Error("invalid transcript snapshot event payload");
  }
  const seq = requiredSequence(envelope.seq, "transcript seq");
  if (requiredString(envelope.sessionId, "sessionId", 512) !== expectedSessionId
    || requiredString(envelope.epoch, "transcript epoch", 256) !== expectedEpoch
    || requiredSequence(envelope.revision, "transcript revision") !== seq) {
    throw new Error("transcript snapshot event identity mismatch");
  }
  return {
    seq,
    eventId: requiredString(envelope.eventId, "eventId", 512),
    event: publishedEventToBrowser(envelope),
  };
}

function publishedEventToBrowser(published: Record<string, unknown>): Record<string, unknown> {
  if (!published.event || typeof published.event !== "object" || Array.isArray(published.event)) {
    throw new Error("invalid transcript event payload");
  }
  const eventId = requiredString(published.eventId, "eventId", 512);
  const event = published.event as Record<string, unknown>;
  return {
    ...event,
    eventId,
    ...(event.createdAt === undefined && typeof published.createdAt === "number" ? { createdAt: published.createdAt } : {}),
    ...(event.author === undefined && typeof published.author === "string" ? { author: published.author } : {}),
    ...(event.usage === undefined && published.usage && typeof published.usage === "object" ? { usage: published.usage } : {}),
    reverseTranscript: {
      epoch: requiredString(published.epoch, "transcript epoch", 256),
      revision: requiredSequence(published.revision, "transcript revision"),
      seq: requiredSequence(published.seq, "transcript seq"),
      eventType: requiredString(published.eventType, "eventType", 128),
      createdAt: published.createdAt ?? null,
      author: published.author ?? null,
      usage: published.usage ?? null,
      artifactRefs: Array.isArray(published.artifactRefs) ? published.artifactRefs : [],
      ...(published.truncation && typeof published.truncation === "object" ? { truncation: published.truncation } : {}),
    },
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`invalid ${field}`);
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, field, max);
}

function requiredSequence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${field}`);
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error(`invalid ${field}`);
  }
  return parsed;
}
