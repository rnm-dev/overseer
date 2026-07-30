import { randomUUID } from "node:crypto";
import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import {
  MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES,
  MAX_TRANSCRIPT_SNAPSHOT_BYTES,
  MAX_TRANSCRIPT_SNAPSHOT_EVENTS,
  TRANSCRIPT_SYNC_CAPABILITY,
  TranscriptPublicationError,
  transcriptLiveEventFrame,
  transcriptPublication,
  type PublishedTranscriptEvent,
  type TranscriptPublicationRepository,
  type TranscriptPublicationUpdate,
} from "../../../transcriptPublication.js";

export {
  MAX_TRANSCRIPT_SNAPSHOT_BYTES,
  MAX_TRANSCRIPT_SNAPSHOT_EVENTS,
} from "../../../transcriptPublication.js";

export const DEFAULT_TRANSCRIPT_SNAPSHOT_PAGE_LIMIT = 50;
export const MAX_TRANSCRIPT_SNAPSHOT_PAGE_LIMIT = 100;
export const MAX_TRANSCRIPT_SNAPSHOT_PAGE_BYTES = 768 * 1024;
export const MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS = 4;
export const MAX_ACTIVE_TRANSCRIPT_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const TRANSCRIPT_SNAPSHOT_TTL_MS = 30_000;
export const MAX_TRANSCRIPT_SUBSCRIPTIONS = 64;
export const TRANSCRIPT_SUBSCRIPTION_TTL_MS = 5 * 60_000;
export const MAX_TRANSCRIPT_CATCHUP_EVENTS = 64;
export const MAX_TRANSCRIPT_CATCHUP_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_OUTSTANDING_PER_SESSION = 64;
export const MAX_TRANSCRIPT_OUTSTANDING_TOTAL = 1_024;

const FRAME_TYPES = new Set([
  "transcript_snapshot_request",
  "transcript_snapshot_cancel",
  "transcript_subscribe",
  "transcript_unsubscribe",
]);

interface Snapshot {
  requestId: string;
  sessionId: string;
  epoch: string;
  revision: number;
  barrierSeq: number;
  events: PublishedTranscriptEvent[];
  bytes: number;
  offsets: Map<string, number>;
  nextCursors: Map<string, string | null>;
  expiresAt: number;
}

interface PendingSnapshot {
  requestId: string;
  sessionId: string;
  generation: number;
  provisionalSubscription: boolean;
  expiresAt: number;
  cancelled: boolean;
}

interface Subscription {
  sessionId: string;
  epoch: string | null;
  lastSentSeq: number;
  ready: boolean;
  buffered: PublishedTranscriptEvent[];
  expiresAt: number;
  provisionalRequestId?: string;
}

interface PendingDeletion {
  sessionId: string;
  epoch: string;
  revision: number;
}

interface TranscriptChannelOptions {
  repository?: TranscriptPublicationRepository;
  now?: () => number;
}

function stringField(frame: PeonSocketFrame, key: string, max = 256): string | null {
  const value = frame[key];
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)
    ? value
    : null;
}

function frameBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export class TranscriptChannel implements PeonSocketChannel {
  readonly capability = TRANSCRIPT_SYNC_CAPABILITY;
  private readonly repository: TranscriptPublicationRepository;
  private readonly now: () => number;
  private sender: PeonSocketSender | null = null;
  private accepted = false;
  private generation = 0;
  private snapshots = new Map<string, Snapshot>();
  private pendingSnapshots = new Map<string, PendingSnapshot>();
  private subscriptions = new Map<string, Subscription>();
  private pendingDeletions = new Map<string, PendingDeletion>();
  private unsubscribeUpdates: (() => void) | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private outstanding = new Map<string, string>();
  private outstandingBySession = new Map<string, number>();

  constructor(options: TranscriptChannelOptions = {}) {
    this.repository = options.repository ?? transcriptPublication;
    this.now = options.now ?? Date.now;
  }

  helloState(): PeonSocketFrame {
    return {
      snapshotPageEvents: MAX_TRANSCRIPT_SNAPSHOT_PAGE_LIMIT,
      snapshotPageBytes: MAX_TRANSCRIPT_SNAPSHOT_PAGE_BYTES,
      snapshotEvents: MAX_TRANSCRIPT_SNAPSHOT_EVENTS,
      snapshotBytes: MAX_TRANSCRIPT_SNAPSHOT_BYTES,
      activeSnapshots: MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS,
      subscriptions: MAX_TRANSCRIPT_SUBSCRIPTIONS,
      subscriptionTtlMs: TRANSCRIPT_SUBSCRIPTION_TTL_MS,
      eventBytes: MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES,
    };
  }

  started(_sender: PeonSocketSender): void {}

  connecting(): void {}

  negotiated(accepted: boolean, _acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    this.generation += 1;
    const active = accepted && sender.durable;
    if (!active) {
      this.reset(true);
      if (accepted) sender.disconnect("transcript sync requires durable-delivery-v1");
      return;
    }
    this.accepted = true;
    this.sender = sender;
    this.unsubscribeUpdates ??= this.repository.subscribe((update) => this.publication(update));
    this.retryPendingDeletions();
    this.scheduleExpiry();
  }

  disconnected(resetAuthority: boolean): void {
    this.generation += 1;
    if (!resetAuthority && this.sender?.durable) {
      // Keep bounded demand active across a transient reconnect. New commits
      // continue entering the persistent outbox and replay on the replacement.
      // Snapshot cursors are scoped to one socket generation and must be
      // restarted after reconnect.
      const sessionIds = new Set([
        ...[...this.snapshots.values()].map((snapshot) => snapshot.sessionId),
        ...[...this.pendingSnapshots.values()].map((snapshot) => snapshot.sessionId),
      ]);
      this.snapshots.clear();
      for (const pending of this.pendingSnapshots.values()) pending.cancelled = true;
      this.pendingSnapshots.clear();
      for (const sessionId of sessionIds) this.releaseIfUnused(sessionId);
      this.scheduleExpiry();
      return;
    }
    this.reset(true);
  }

  handles(frame: PeonSocketFrame): boolean {
    return typeof frame.type === "string" && FRAME_TYPES.has(frame.type);
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted || sender !== this.sender) return sender.disconnect("unnegotiated transcript frame");
    const generation = this.generation;
    if (frame.type === "transcript_snapshot_cancel") {
      this.cancelSnapshot(frame, sender);
      return;
    }
    if (frame.type === "transcript_unsubscribe") {
      this.unsubscribe(frame, sender);
      return;
    }
    if (frame.type === "transcript_subscribe") {
      void this.subscribe(frame, sender, generation);
      return;
    }
    void this.snapshot(frame, sender, generation);
  }

  durableAcknowledged(cursor: string): void {
    const sessionId = this.outstanding.get(cursor);
    if (sessionId) {
      this.outstanding.delete(cursor);
      const remaining = Math.max(0, (this.outstandingBySession.get(sessionId) ?? 1) - 1);
      if (remaining === 0) this.outstandingBySession.delete(sessionId);
      else this.outstandingBySession.set(sessionId, remaining);
    }
    this.retryPendingDeletions();
  }

  private async snapshot(frame: PeonSocketFrame, sender: PeonSocketSender, generation: number): Promise<void> {
    const requestId = stringField(frame, "requestId", 200);
    const sessionId = stringField(frame, "sessionId");
    if (!requestId || !sessionId) return this.error(sender, requestId, sessionId, "BAD_REQUEST", "requestId and sessionId are required");
    const cursor = frame.cursor === undefined ? undefined : stringField(frame, "cursor", 200);
    if (frame.cursor !== undefined && !cursor) return this.error(sender, requestId, sessionId, "BAD_CURSOR", "invalid transcript cursor");
    const limit = this.limit(frame.limit, sender, requestId, sessionId);
    if (limit === null) return;

    let snapshot = this.snapshots.get(requestId);
    if (snapshot && snapshot.sessionId !== sessionId) {
      return this.error(sender, requestId, sessionId, "BAD_CURSOR", "snapshot request belongs to another session");
    }
    if (snapshot && this.rejectExpiredSnapshot(snapshot, sender)) return;
    const existingPending = this.pendingSnapshots.get(requestId);
    if (existingPending) {
      if (existingPending.sessionId !== sessionId) {
        return this.error(sender, requestId, sessionId, "BAD_CURSOR", "snapshot request belongs to another session");
      }
      return this.error(sender, requestId, sessionId, "BAD_REQUEST", "transcript snapshot request is still loading");
    }
    if (!snapshot && cursor) return this.error(sender, requestId, sessionId, "CURSOR_UNAVAILABLE", "transcript snapshot cursor expired");
    if (!snapshot) {
      this.expire();
      if (this.snapshots.size + this.pendingSnapshots.size >= MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS) {
        return this.error(sender, requestId, sessionId, "SNAPSHOT_LIMIT", "too many transcript snapshots are active");
      }
      const subscribe = frame.subscribe === true;
      let provisionalSubscription = false;
      if (subscribe && !this.subscriptions.has(sessionId)) {
        if (this.subscriptions.size >= MAX_TRANSCRIPT_SUBSCRIPTIONS) {
          return this.error(sender, requestId, sessionId, "SUBSCRIPTION_LIMIT", "too many transcript subscriptions are active");
        }
        provisionalSubscription = true;
        this.subscriptions.set(sessionId, {
          sessionId, epoch: null, lastSentSeq: 0, ready: false, buffered: [],
          expiresAt: this.now() + TRANSCRIPT_SUBSCRIPTION_TTL_MS,
          provisionalRequestId: requestId,
        });
      }
      const reservation: PendingSnapshot = {
        requestId,
        sessionId,
        generation,
        provisionalSubscription,
        expiresAt: this.now() + TRANSCRIPT_SNAPSHOT_TTL_MS,
        cancelled: false,
      };
      // Count the request before repository I/O or any full snapshot clone.
      this.pendingSnapshots.set(requestId, reservation);
      this.scheduleExpiry();
      try {
        const state = await this.repository.state(sessionId);
        if (this.rejectExpiredReservation(reservation, sender)) return;
        if (!this.reservationCurrent(reservation, sender)) {
          this.dropPendingSnapshot(reservation, reservation.expiresAt <= this.now());
          return;
        }
        const bytes = state.bytes;
        if (state.entries.length > MAX_TRANSCRIPT_SNAPSHOT_EVENTS || bytes > MAX_TRANSCRIPT_SNAPSHOT_BYTES
          || this.snapshotBytes() + bytes > MAX_ACTIVE_TRANSCRIPT_SNAPSHOT_BYTES) {
          this.dropPendingSnapshot(reservation, true);
          return this.error(sender, requestId, sessionId, "SNAPSHOT_TOO_LARGE", "transcript snapshot exceeds Peon bounds");
        }
        const events = state.entries.map((event) => structuredClone(event));
        snapshot = {
          requestId,
          sessionId,
          epoch: state.epoch,
          revision: state.revision,
          barrierSeq: state.revision,
          events,
          bytes,
          offsets: new Map([["", 0]]),
          nextCursors: new Map(),
          expiresAt: this.now() + TRANSCRIPT_SNAPSHOT_TTL_MS,
        };
        this.pendingSnapshots.delete(requestId);
        this.snapshots.set(requestId, snapshot);
        if (subscribe) {
          const subscription = this.subscriptions.get(sessionId);
          if (subscription) {
            subscription.epoch = snapshot.epoch;
            subscription.lastSentSeq = snapshot.barrierSeq;
            subscription.ready = true;
            delete subscription.provisionalRequestId;
            const buffered = subscription.buffered
              .filter((event) => event.epoch === snapshot!.epoch && event.seq > snapshot!.barrierSeq)
              .sort((a, b) => a.seq - b.seq);
            subscription.buffered = [];
            for (const event of buffered) {
              if (!this.sendLive(event, subscription)) break;
            }
          }
        }
      } catch (error) {
        if (this.rejectExpiredReservation(reservation, sender)) return;
        if (!this.reservationCurrent(reservation, sender)) {
          this.dropPendingSnapshot(reservation, reservation.expiresAt <= this.now());
          return;
        }
        this.dropPendingSnapshot(reservation, true);
        if (error instanceof TranscriptPublicationError) {
          return this.error(sender, requestId, sessionId, error.code, error.message);
        }
        return this.error(sender, requestId, sessionId, "INTERNAL", "transcript snapshot failed");
      }
    }
    this.sendSnapshotPage(snapshot, cursor ?? "", limit, sender);
  }

  private sendSnapshotPage(snapshot: Snapshot, cursor: string, limit: number, sender: PeonSocketSender): void {
    if (this.rejectExpiredSnapshot(snapshot, sender)) return;
    const offset = snapshot.offsets.get(cursor);
    if (offset === undefined) return this.error(sender, snapshot.requestId, snapshot.sessionId, "BAD_CURSOR", "invalid transcript cursor");
    const events: PublishedTranscriptEvent[] = [];
    let bytes = 0;
    for (const event of snapshot.events.slice(offset, offset + limit)) {
      const eventBytes = frameBytes(event);
      if (events.length > 0 && bytes + eventBytes > MAX_TRANSCRIPT_SNAPSHOT_PAGE_BYTES) break;
      events.push(event);
      bytes += eventBytes;
    }
    const nextOffset = offset + events.length;
    const hasMore = nextOffset < snapshot.events.length;
    const cached = snapshot.nextCursors.get(cursor);
    const nextCursor = cached === undefined ? (hasMore ? randomUUID() : null) : cached;
    if (cached === undefined) {
      snapshot.nextCursors.set(cursor, nextCursor);
      if (nextCursor) snapshot.offsets.set(nextCursor, nextOffset);
    }
    snapshot.expiresAt = this.now() + TRANSCRIPT_SNAPSHOT_TTL_MS;
    if (!sender.send({
      type: "transcript_snapshot_page",
      requestId: snapshot.requestId,
      sessionId: snapshot.sessionId,
      epoch: snapshot.epoch,
      revision: snapshot.revision,
      barrierSeq: snapshot.barrierSeq,
      events,
      nextCursor,
      hasMore,
    })) sender.disconnect("transcript snapshot backpressure limit exceeded");
    this.scheduleExpiry();
  }

  private async subscribe(frame: PeonSocketFrame, sender: PeonSocketSender, generation: number): Promise<void> {
    const requestId = stringField(frame, "requestId", 200);
    const sessionId = stringField(frame, "sessionId");
    const epoch = stringField(frame, "epoch", 200);
    const afterSeq = frame.afterSeq;
    if (!requestId || !sessionId || !epoch || !Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0) {
      return this.error(sender, requestId, sessionId, "BAD_REQUEST", "requestId, sessionId, epoch and non-negative afterSeq are required");
    }
    if (!this.subscriptions.has(sessionId) && this.subscriptions.size >= MAX_TRANSCRIPT_SUBSCRIPTIONS) {
      return this.error(sender, requestId, sessionId, "SUBSCRIPTION_LIMIT", "too many transcript subscriptions are active");
    }
    try {
      const state = await this.repository.state(sessionId);
      if (!this.current(sender, generation)) return;
      if (state.epoch !== epoch || (afterSeq as number) > state.revision) {
        return this.error(sender, requestId, sessionId, "CURSOR_UNAVAILABLE", "transcript cursor requires a fresh snapshot");
      }
      const catchup = state.entries.slice(afterSeq as number);
      if (catchup.length > MAX_TRANSCRIPT_CATCHUP_EVENTS || frameBytes(catchup) > MAX_TRANSCRIPT_CATCHUP_BYTES) {
        return this.error(sender, requestId, sessionId, "CURSOR_UNAVAILABLE", "transcript catch-up requires a fresh snapshot");
      }
      const subscription: Subscription = {
        sessionId,
        epoch,
        lastSentSeq: afterSeq as number,
        ready: true,
        buffered: [],
        expiresAt: this.now() + TRANSCRIPT_SUBSCRIPTION_TTL_MS,
      };
      this.subscriptions.set(sessionId, subscription);
      for (const event of catchup) {
        if (!this.sendLive(event, subscription)) return;
      }
      if (!sender.send({
        type: "transcript_subscribed",
        requestId,
        sessionId,
        epoch,
        afterSeq: subscription.lastSentSeq,
        expiresAt: subscription.expiresAt,
      })) sender.disconnect("transcript subscription acknowledgement was backpressured");
      this.scheduleExpiry();
    } catch (error) {
      if (!this.current(sender, generation)) return;
      if (error instanceof TranscriptPublicationError) {
        return this.error(sender, requestId, sessionId, error.code, error.message);
      }
      this.error(sender, requestId, sessionId, "INTERNAL", "transcript subscription failed");
    }
  }

  private unsubscribe(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    const requestId = stringField(frame, "requestId", 200);
    const sessionId = stringField(frame, "sessionId");
    if (!requestId || !sessionId) return this.error(sender, requestId, sessionId, "BAD_REQUEST", "requestId and sessionId are required");
    this.subscriptions.delete(sessionId);
    this.releaseIfUnused(sessionId);
    if (!sender.send({ type: "transcript_unsubscribed", requestId, sessionId })) {
      sender.disconnect("transcript unsubscribe acknowledgement was backpressured");
    }
  }

  private cancelSnapshot(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    const requestId = stringField(frame, "requestId", 200);
    if (!requestId) return this.error(sender, null, null, "BAD_REQUEST", "requestId is required");
    const pending = this.pendingSnapshots.get(requestId);
    if (pending) {
      pending.cancelled = true;
      this.dropPendingSnapshot(pending, true);
    }
    const snapshot = this.snapshots.get(requestId);
    if (snapshot) {
      this.snapshots.delete(requestId);
      this.releaseIfUnused(snapshot.sessionId);
    }
    if (!sender.send({ type: "transcript_snapshot_cancelled", requestId })) {
      sender.disconnect("transcript snapshot cancellation was backpressured");
    }
  }

  private publication(update: TranscriptPublicationUpdate): void {
    if (!this.accepted || !this.sender) return;
    if (update.type === "resync") {
      if (this.subscriptions.has(update.sessionId)) this.requireResync(update.sessionId, update.reason);
      return;
    }
    if (update.type === "deleted") {
      const subscription = this.subscriptions.get(update.sessionId);
      if (!subscription) return;
      const deletion = {
        sessionId: update.sessionId,
        epoch: update.epoch,
        revision: update.revision,
      };
      this.pendingDeletions.set(update.sessionId, deletion);
      this.admitDeletion(deletion);
      return;
    }
    const subscription = this.subscriptions.get(update.event.sessionId);
    if (!subscription) return;
    if (!subscription.ready) {
      if (subscription.buffered.length >= MAX_TRANSCRIPT_CATCHUP_EVENTS) {
        this.requireResync(update.event.sessionId, "snapshot/live buffer limit exceeded");
      } else {
        subscription.buffered.push(update.event);
      }
      return;
    }
    this.sendLive(update.event, subscription);
  }

  private sendLive(event: PublishedTranscriptEvent, subscription: Subscription): boolean {
    if (!this.sender) return false;
    if (subscription.epoch !== event.epoch || event.seq !== subscription.lastSentSeq + 1) {
      if (event.epoch === subscription.epoch && event.seq <= subscription.lastSentSeq) return true;
      this.requireResync(event.sessionId, "transcript event sequence gap");
      return false;
    }
    const perSession = this.outstandingBySession.get(event.sessionId) ?? 0;
    if (perSession >= MAX_TRANSCRIPT_OUTSTANDING_PER_SESSION || this.outstanding.size >= MAX_TRANSCRIPT_OUTSTANDING_TOTAL) {
      this.requireResync(event.sessionId, "transcript durable backlog limit exceeded");
      return false;
    }
    const result = this.sender.sendDurable(transcriptLiveEventFrame(event), {
      priority: event.eventType === "result" ? "critical" : event.eventType === "warning" ? "control" : "normal",
      capability: this.capability,
      dedupeKey: `transcript:${event.sessionId}:${event.epoch}:${event.seq}:${event.eventId}`,
    });
    if (!result.accepted) {
      this.requireResync(event.sessionId, "transcript durable outbox is backpressured");
      return false;
    }
    subscription.lastSentSeq = event.seq;
    subscription.expiresAt = this.now() + TRANSCRIPT_SUBSCRIPTION_TTL_MS;
    this.trackOutstanding(result.cursor, event.sessionId);
    return true;
  }

  private admitDeletion(deletion: PendingDeletion): boolean {
    if (!this.accepted || !this.sender || this.pendingDeletions.get(deletion.sessionId) !== deletion) return false;
    const result = this.sender.sendDurable({
      type: "transcript_deleted",
      sessionId: deletion.sessionId,
      epoch: deletion.epoch,
      revision: deletion.revision,
    }, {
      priority: "critical",
      capability: this.capability,
      dedupeKey: `transcript-deleted:${deletion.sessionId}:${deletion.epoch}`,
    });
    if (!result.accepted) return false;

    this.trackOutstanding(result.cursor, deletion.sessionId);
    this.pendingDeletions.delete(deletion.sessionId);
    this.subscriptions.delete(deletion.sessionId);
    for (const [requestId, snapshot] of this.snapshots) {
      if (snapshot.sessionId === deletion.sessionId) this.snapshots.delete(requestId);
    }
    for (const pending of [...this.pendingSnapshots.values()]) {
      if (pending.sessionId !== deletion.sessionId) continue;
      pending.cancelled = true;
      this.dropPendingSnapshot(pending, false);
    }
    this.repository.release(deletion.sessionId);
    this.scheduleExpiry();
    return true;
  }

  private retryPendingDeletions(): void {
    if (!this.accepted || !this.sender) return;
    for (const deletion of [...this.pendingDeletions.values()]) {
      this.admitDeletion(deletion);
    }
  }

  private trackOutstanding(cursor: string, sessionId: string): void {
    if (this.outstanding.has(cursor)) return;
    this.outstanding.set(cursor, sessionId);
    this.outstandingBySession.set(sessionId, (this.outstandingBySession.get(sessionId) ?? 0) + 1);
  }

  private requireResync(sessionId: string, reason: string): void {
    this.subscriptions.delete(sessionId);
    const sender = this.sender;
    if (sender && !sender.send({
      type: "transcript_error",
      requestId: null,
      sessionId,
      code: "RESYNC_REQUIRED",
      error: reason,
    })) sender.disconnect("transcript resync signal was backpressured");
    this.releaseIfUnused(sessionId);
  }

  private limit(raw: unknown, sender: PeonSocketSender, requestId: string, sessionId: string): number | null {
    if (raw === undefined) return DEFAULT_TRANSCRIPT_SNAPSHOT_PAGE_LIMIT;
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      this.error(sender, requestId, sessionId, "BAD_REQUEST", "transcript snapshot limit must be a positive integer");
      return null;
    }
    return Math.min(raw as number, MAX_TRANSCRIPT_SNAPSHOT_PAGE_LIMIT);
  }

  private error(
    sender: PeonSocketSender,
    requestId: string | null,
    sessionId: string | null,
    code: string,
    message: string,
  ): void {
    if (!sender.send({ type: "transcript_error", requestId, sessionId, code, error: message })) {
      sender.disconnect("transcript error frame was backpressured");
    }
  }

  private current(sender: PeonSocketSender, generation: number): boolean {
    return this.accepted && this.sender === sender && this.generation === generation;
  }

  private reservationCurrent(reservation: PendingSnapshot, sender: PeonSocketSender): boolean {
    return !reservation.cancelled
      && this.pendingSnapshots.get(reservation.requestId) === reservation
      && reservation.generation === this.generation
      && reservation.expiresAt > this.now()
      && this.current(sender, reservation.generation);
  }

  private rejectExpiredSnapshot(snapshot: Snapshot, sender: PeonSocketSender): boolean {
    if (snapshot.expiresAt > this.now()) return false;
    // Pending deletion intentionally retains bounded state until its terminal
    // frame is durably admitted, but never revives an expired external cursor.
    if (!this.pendingDeletions.has(snapshot.sessionId)) {
      this.snapshots.delete(snapshot.requestId);
      this.releaseIfUnused(snapshot.sessionId);
      this.scheduleExpiry();
    }
    this.error(sender, snapshot.requestId, snapshot.sessionId, "CURSOR_UNAVAILABLE", "transcript snapshot cursor expired");
    return true;
  }

  private rejectExpiredReservation(reservation: PendingSnapshot, sender: PeonSocketSender): boolean {
    if (reservation.expiresAt > this.now()) return false;
    const notify = !reservation.cancelled
      && this.pendingSnapshots.get(reservation.requestId) === reservation
      && reservation.generation === this.generation
      && this.current(sender, reservation.generation);
    this.dropPendingSnapshot(reservation, true);
    if (notify) {
      this.error(sender, reservation.requestId, reservation.sessionId, "CURSOR_UNAVAILABLE", "transcript snapshot cursor expired");
    }
    return true;
  }

  private dropPendingSnapshot(reservation: PendingSnapshot, removeProvisionalSubscription: boolean): void {
    if (this.pendingSnapshots.get(reservation.requestId) !== reservation) return;
    reservation.cancelled = true;
    this.pendingSnapshots.delete(reservation.requestId);
    if (removeProvisionalSubscription && reservation.provisionalSubscription) {
      const subscription = this.subscriptions.get(reservation.sessionId);
      if (subscription?.provisionalRequestId === reservation.requestId && !subscription.ready) {
        this.subscriptions.delete(reservation.sessionId);
      }
    }
    this.releaseIfUnused(reservation.sessionId);
    this.scheduleExpiry();
  }

  private snapshotBytes(): number {
    let total = 0;
    for (const snapshot of this.snapshots.values()) total += snapshot.bytes;
    return total;
  }

  private expire(): void {
    const now = this.now();
    const released = new Set<string>();
    for (const pending of [...this.pendingSnapshots.values()]) {
      if (pending.expiresAt > now || this.pendingDeletions.has(pending.sessionId)) continue;
      pending.cancelled = true;
      this.dropPendingSnapshot(pending, true);
      released.add(pending.sessionId);
    }
    for (const [requestId, snapshot] of this.snapshots) {
      if (snapshot.expiresAt > now || this.pendingDeletions.has(snapshot.sessionId)) continue;
      this.snapshots.delete(requestId);
      released.add(snapshot.sessionId);
    }
    for (const [sessionId, subscription] of this.subscriptions) {
      if (subscription.expiresAt > now || this.pendingDeletions.has(sessionId)) continue;
      this.subscriptions.delete(sessionId);
      released.add(sessionId);
    }
    for (const sessionId of released) this.releaseIfUnused(sessionId);
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (!this.accepted || (
      this.snapshots.size === 0
      && this.pendingSnapshots.size === 0
      && this.subscriptions.size === 0
      && this.pendingDeletions.size === 0
    )) {
      this.expiryTimer = null;
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expire();
      this.retryPendingDeletions();
      this.scheduleExpiry();
    }, Math.min(TRANSCRIPT_SNAPSHOT_TTL_MS, TRANSCRIPT_SUBSCRIPTION_TTL_MS));
    this.expiryTimer.unref();
  }

  private releaseIfUnused(sessionId: string): void {
    if (this.subscriptions.has(sessionId)) return;
    if (this.pendingDeletions.has(sessionId)) return;
    for (const snapshot of this.snapshots.values()) if (snapshot.sessionId === sessionId) return;
    for (const snapshot of this.pendingSnapshots.values()) if (snapshot.sessionId === sessionId) return;
    this.repository.release(sessionId);
  }

  private reset(release: boolean): void {
    this.accepted = false;
    this.sender = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (release) {
      const sessionIds = new Set([
        ...this.subscriptions.keys(),
        ...[...this.snapshots.values()].map((snapshot) => snapshot.sessionId),
        ...[...this.pendingSnapshots.values()].map((snapshot) => snapshot.sessionId),
        ...this.pendingDeletions.keys(),
      ]);
      this.subscriptions.clear();
      this.snapshots.clear();
      for (const pending of this.pendingSnapshots.values()) pending.cancelled = true;
      this.pendingSnapshots.clear();
      this.pendingDeletions.clear();
      for (const sessionId of sessionIds) this.repository.release(sessionId);
      this.unsubscribeUpdates?.();
      this.unsubscribeUpdates = null;
      this.outstanding.clear();
      this.outstandingBySession.clear();
    }
  }
}
