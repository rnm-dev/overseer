import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  applySocketSessionEvent,
  applySocketSessionSnapshot,
  claimSessionSyncGeneration,
  commitSnapshotCoveredSessionEvent,
  markSessionSyncing,
  releaseSessionSyncGeneration,
  type PeonSession,
  type SessionSyncCheckpoint,
} from "../modules/sessions/index.js";
import { observeSessionCatalogDuration, observeSessionCatalogEvent } from "../modules/sessions/index.js";
import {
  applySocketProjectEvent,
  applySocketProjectSnapshot,
  claimProjectSyncGeneration,
  commitSnapshotCoveredProjectEvent,
  markProjectSyncing,
  releaseProjectSyncGeneration,
  normalizeProjectQuickLinks,
  type PeonProject,
  type ProjectSyncCheckpoint,
} from "../modules/projects/index.js";
import type { PeonRecord } from "../modules/fleet/index.js";
import {
  parseDurableReverseCommandResult,
  REVERSE_COMMAND_CAPABILITY,
  ReverseCommandProtocolError,
  reverseCommandGateway,
  type DurableReverseCommandResult,
} from "../modules/reverseCommands/index.js";
import {
  commitRuntimeState,
  parseDurableRuntimeState,
  RUNTIME_STATE_CAPABILITY,
  type DurableRuntimeState,
} from "../modules/fleet/index.js";
import { CatalogSnapshot, CatalogSnapshotError } from "./catalogSnapshot.js";

export const SESSION_CATALOG_CAPABILITY = "session-catalog-v1";
export const PROJECT_CATALOG_CAPABILITY = "project-catalog-v1";
export const DURABLE_DELIVERY_CAPABILITY = "durable-delivery-v1";

const PAGE_LIMIT = 100;
const MAX_PAGE_ITEMS = 250;
const MAX_SNAPSHOT_ITEMS = 10_000;
const MAX_SNAPSHOT_PAGES = 1_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_EVENTS = 1_000;
const SYNC_TIMEOUT_MS = 60_000;

interface CatalogHello {
  epoch: string;
  revision: number;
  earliestSeq: number;
  latestSeq: number;
}

interface DeliveryHello {
  epoch: string;
  earliestCursor: string | null;
  latestCursor: string | null;
  acknowledgedCursor: string | null;
  pendingMessages: number;
}

interface DurableCatalogEvent {
  channel: "session" | "project";
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  catalogEpoch: string;
  seq: number;
  operation: "upsert" | "delete";
  session?: PeonSession;
  sessionId?: string;
  project?: PeonProject;
  projectId?: string;
}

type DurableDeliveryEvent = DurableCatalogEvent | DurableReverseCommandResult | DurableRuntimeState;

export class SessionSyncProtocolError extends Error {}

// Connection-wide coordinator despite the historical filename: it owns the one
// durable delivery frontier and dispatches typed payloads to independent
// session/project catalog projections.
export class PeonCatalogSync {
  private snapshot: CatalogSnapshot<PeonSession> | null = null;
  private projectSnapshot: CatalogSnapshot<PeonProject> | null = null;
  private checkpoint: SessionSyncCheckpoint | null = null;
  private projectCheckpoint: ProjectSyncCheckpoint | null = null;
  private bufferedEvents: DurableDeliveryEvent[] = [];
  private bufferedEventFingerprints = new Map<string, string>();
  private bufferedBytes = 0;
  private sessionTimer: NodeJS.Timeout | null = null;
  private projectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private receivedDurableMessage = false;
  private enforceAdvertisedEarliestCursor = true;
  private recoveryStartedAt = 0;

  constructor(
    private readonly record: PeonRecord,
    private readonly ws: WebSocket,
    private readonly catalog: CatalogHello,
    private readonly delivery: DeliveryHello,
    private readonly projectCatalog: CatalogHello | null = null,
    private readonly additionalCapabilities: readonly string[] = [],
    private readonly additionalChannels: Readonly<Record<string, unknown>> = {},
    private readonly generation: string = randomUUID(),
  ) {}

  async start(beforeHelloAck?: () => Promise<void>): Promise<void> {
    this.recoveryStartedAt = Date.now();
    this.checkpoint = await claimSessionSyncGeneration(this.record.peonId, this.generation);
    const catalogResume = this.checkpoint?.catalog?.epoch === this.catalog.epoch
      && this.checkpoint.catalog.acknowledgedSeq >= this.catalog.earliestSeq - 1
      && this.checkpoint.catalog.acknowledgedSeq <= this.catalog.latestSeq
      ? this.checkpoint.catalog
      : null;
    const deliveryResume = this.checkpoint?.delivery?.epoch === this.delivery.epoch
      ? this.checkpoint.delivery
      : null;
    // The hello describes Peon's outbox before it processes our hello_ack.
    // When Overseer has committed farther than Peon's locally persisted
    // acknowledgement, the ack below legitimately trims the advertised first
    // message before Peon starts flushing. Its next cursor is opaque to us, so
    // the pre-ack earliest cursor cannot be enforced on this connection.
    this.enforceAdvertisedEarliestCursor = !(
      deliveryResume?.acknowledgedCursor
      && deliveryResume.acknowledgedCursor !== this.delivery.acknowledgedCursor
    );
    this.projectCheckpoint = this.projectCatalog
      ? await claimProjectSyncGeneration(this.record.peonId, this.generation)
      : null;
    const projectResume = this.projectCatalog
      && this.projectCheckpoint?.catalog?.epoch === this.projectCatalog.epoch
      && this.projectCheckpoint.catalog.acknowledgedSeq >= this.projectCatalog.earliestSeq - 1
      && this.projectCheckpoint.catalog.acknowledgedSeq <= this.projectCatalog.latestSeq
      ? this.projectCheckpoint.catalog
      : null;

    const channels: Record<string, unknown> = { ...this.additionalChannels };
    if (catalogResume) channels[SESSION_CATALOG_CAPABILITY] = {
      epoch: catalogResume.epoch,
      acknowledgedSeq: catalogResume.acknowledgedSeq,
    };
    if (projectResume) channels[PROJECT_CATALOG_CAPABILITY] = {
      epoch: projectResume.epoch,
      acknowledgedSeq: projectResume.acknowledgedSeq,
    };

    await beforeHelloAck?.();
    this.send({
      type: "hello_ack",
      protocol: 1,
      capabilities: [
        SESSION_CATALOG_CAPABILITY,
        DURABLE_DELIVERY_CAPABILITY,
        ...(this.projectCatalog ? [PROJECT_CATALOG_CAPABILITY] : []),
        ...this.additionalCapabilities,
      ],
      channels,
      delivery: deliveryResume ? {
        epoch: deliveryResume.epoch,
        acknowledgedCursor: deliveryResume.acknowledgedCursor,
      } : undefined,
    });

    // Both resume domains must match. A mismatch is fenced by a fresh catalog
    // snapshot; no stale acknowledgement is reused across either epoch.
    if (!catalogResume || !deliveryResume || !this.checkpoint?.previouslyReady) {
      await markSessionSyncing(this.record.peonId, this.generation);
      this.requestSnapshot();
    } else {
      observeSessionCatalogDuration("reconnect", "success", Date.now() - this.recoveryStartedAt);
    }
    if (this.projectCatalog && (!projectResume || !deliveryResume || !this.projectCheckpoint?.previouslyReady)) {
      await markProjectSyncing(this.record.peonId, this.generation);
      this.requestProjectSnapshot();
    }
  }

  async handle(message: Record<string, unknown>, frameBytes: number): Promise<boolean> {
    switch (message.type) {
      case "session_catalog_snapshot_page":
        await this.receiveSnapshotPage(message, frameBytes);
        return true;
      case "project_catalog_snapshot_page":
        await this.receiveProjectSnapshotPage(message, frameBytes);
        return true;
      case "durable_message":
        await this.receiveDurableMessage(message, frameBytes);
        return true;
      case "session_catalog_snapshot_cancelled":
        this.requireActiveRequest(message);
        throw new SessionSyncProtocolError("session catalog snapshot cancelled");
      case "session_catalog_error":
        throw new SessionSyncProtocolError(`session catalog error: ${requiredString(message.code, "code", 64)}`);
      case "project_catalog_snapshot_cancelled":
        this.requireActiveProjectRequest(message);
        throw new SessionSyncProtocolError("project catalog snapshot cancelled");
      case "project_catalog_error":
        throw new SessionSyncProtocolError(`project catalog error: ${requiredString(message.code, "code", 64)}`);
      default:
        return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    if (this.projectTimer) clearTimeout(this.projectTimer);
    this.sessionTimer = null;
    this.projectTimer = null;
    this.snapshot = null;
    this.projectSnapshot = null;
    this.bufferedEvents = [];
    this.bufferedEventFingerprints.clear();
    void releaseSessionSyncGeneration(this.record.peonId, this.generation).catch(() => undefined);
    if (this.projectCatalog) void releaseProjectSyncGeneration(this.record.peonId, this.generation).catch(() => undefined);
  }

  private requestSnapshot(cursor?: string): void {
    if (!this.snapshot) {
      this.snapshot = new CatalogSnapshot("session", this.catalog.epoch, {
        maxPageItems: MAX_PAGE_ITEMS, maxItems: MAX_SNAPSHOT_ITEMS,
        maxPages: MAX_SNAPSHOT_PAGES, maxBytes: MAX_SNAPSHOT_BYTES,
      });
    }
    const frame: Record<string, unknown> = {
      type: "session_catalog_snapshot_request",
      requestId: this.snapshot.requestId,
      limit: PAGE_LIMIT,
    };
    if (cursor !== undefined) frame.cursor = cursor;
    this.send(frame);
    this.armTimer("session");
  }

  private async receiveSnapshotPage(message: Record<string, unknown>, frameBytes: number): Promise<void> {
    const snapshot = this.requireActiveRequest(message);
    if (!Array.isArray(message.sessions) || message.sessions.length > MAX_PAGE_ITEMS) {
      throw new SessionSyncProtocolError("invalid session catalog snapshot page");
    }
    const epoch = requiredString(message.epoch, "epoch", 256);
    const revision = requiredSequence(message.revision, "revision");
    const barrierSeq = requiredSequence(message.barrierSeq, "barrierSeq");
    const hasMore = message.hasMore;
    if (typeof hasMore !== "boolean") throw new SessionSyncProtocolError("invalid hasMore");
    const nextCursor = optionalString(message.nextCursor, "nextCursor", 2_000);
    if (hasMore !== (nextCursor !== null)) throw new SessionSyncProtocolError("snapshot pagination mismatch");

    let result;
    try {
      result = snapshot.append({ epoch, revision, barrierSeq, hasMore, nextCursor, frameBytes,
        rawItems: message.sessions, parse: parseSession, identity: (session) => session.id });
    } catch (error) {
      if (error instanceof CatalogSnapshotError) throw new SessionSyncProtocolError(error.message);
      throw error;
    }
    if (!result.complete) {
      this.requestSnapshot(result.nextCursor ?? undefined);
      return;
    }

    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    await applySocketSessionSnapshot({
      workspaceId: this.record.workspaceId,
      peonId: this.record.peonId,
      generation: this.generation,
      catalogEpoch: epoch,
      barrierSeq,
      deliveryEpoch: this.delivery.epoch,
      acknowledgedCursor: this.checkpoint?.delivery?.epoch === this.delivery.epoch
        ? this.checkpoint.delivery.acknowledgedCursor
        : null,
      sessions: snapshot.items,
    });
    this.checkpoint = {
      catalog: { epoch, acknowledgedSeq: barrierSeq },
      delivery: {
        epoch: this.delivery.epoch,
        acknowledgedCursor: this.checkpoint?.delivery?.epoch === this.delivery.epoch
          ? this.checkpoint.delivery.acknowledgedCursor
          : null,
      },
      previouslyReady: true,
    };
    observeSessionCatalogDuration("snapshot", "success", Date.now() - snapshot.startedAt);
    observeSessionCatalogDuration("reconnect", "success", Date.now() - this.recoveryStartedAt);
    observeSessionCatalogEvent("rebuild");
    this.snapshot = null;
    this.send({ type: "session_catalog_ack", epoch, acknowledgedSeq: barrierSeq });
    await this.maybeDrainBuffered();
  }

  private requestProjectSnapshot(cursor?: string): void {
    if (!this.projectSnapshot) {
      this.projectSnapshot = new CatalogSnapshot("project", this.projectCatalog!.epoch, {
        maxPageItems: MAX_PAGE_ITEMS, maxItems: MAX_SNAPSHOT_ITEMS,
        maxPages: MAX_SNAPSHOT_PAGES, maxBytes: MAX_SNAPSHOT_BYTES,
      });
    }
    const frame: Record<string, unknown> = {
      type: "project_catalog_snapshot_request",
      requestId: this.projectSnapshot.requestId,
      limit: PAGE_LIMIT,
    };
    if (cursor !== undefined) frame.cursor = cursor;
    this.send(frame);
    this.armTimer("project");
  }

  private async receiveProjectSnapshotPage(message: Record<string, unknown>, frameBytes: number): Promise<void> {
    const snapshot = this.requireActiveProjectRequest(message);
    if (!Array.isArray(message.projects) || message.projects.length > MAX_PAGE_ITEMS) {
      throw new SessionSyncProtocolError("invalid project catalog snapshot page");
    }
    const epoch = requiredString(message.epoch, "epoch", 256);
    const revision = requiredSequence(message.revision, "revision");
    const barrierSeq = requiredSequence(message.barrierSeq, "barrierSeq");
    if (typeof message.hasMore !== "boolean") throw new SessionSyncProtocolError("invalid hasMore");
    const nextCursor = optionalString(message.nextCursor, "nextCursor", 2_000);
    if (message.hasMore !== (nextCursor !== null)) throw new SessionSyncProtocolError("snapshot pagination mismatch");
    let result;
    try {
      result = snapshot.append({ epoch, revision, barrierSeq, hasMore: message.hasMore, nextCursor, frameBytes,
        rawItems: message.projects, parse: parseProject, identity: (project) => project.projectId });
    } catch (error) {
      if (error instanceof CatalogSnapshotError) throw new SessionSyncProtocolError(error.message);
      throw error;
    }
    if (!result.complete) {
      this.requestProjectSnapshot(result.nextCursor ?? undefined);
      return;
    }
    await applySocketProjectSnapshot({
      workspaceId: this.record.workspaceId,
      peonId: this.record.peonId,
      generation: this.generation,
      catalogEpoch: epoch,
      barrierSeq,
      projects: snapshot.items,
    });
    this.projectCheckpoint = { catalog: { epoch, acknowledgedSeq: barrierSeq }, previouslyReady: true };
    this.projectSnapshot = null;
    this.send({ type: "project_catalog_ack", epoch, acknowledgedSeq: barrierSeq });
    if (this.projectTimer) clearTimeout(this.projectTimer);
    this.projectTimer = null;
    await this.maybeDrainBuffered();
  }

  private async receiveDurableMessage(message: Record<string, unknown>, frameBytes: number): Promise<void> {
    const event = this.parseDurableEvent(message);
    if (event.deliveryEpoch !== this.delivery.epoch) throw new SessionSyncProtocolError("durable delivery epoch mismatch");
    if (!this.receivedDurableMessage && this.enforceAdvertisedEarliestCursor
      && this.delivery.pendingMessages > 0
      && event.deliveryCursor !== this.delivery.earliestCursor) {
      throw new SessionSyncProtocolError("durable delivery cursor gap");
    }
    this.receivedDurableMessage = true;
    if (this.snapshot || this.projectSnapshot) {
      this.bufferEvent(event, frameBytes);
      return;
    }
    if (event.channel === "runtime") {
      await this.applyEvent(event);
      return;
    }
    const checkpoint = event.channel === "session"
      ? this.checkpoint?.catalog
      : event.channel === "project" ? this.projectCheckpoint?.catalog : null;
    if (event.channel !== "command" && !checkpoint) {
      throw new SessionSyncProtocolError(`${event.channel} catalog event arrived before snapshot`);
    }
    // Peon may coalesce replaceable summaries before their durable cursor is
    // sent. That intentionally preserves the delivery frontier while skipping
    // one or more catalog sequence numbers. Fence the queued event behind a
    // fresh authoritative snapshot instead of poisoning every reconnect.
    if (event.channel !== "command"
      && checkpoint
      && checkpoint.epoch === event.catalogEpoch
      && event.seq > checkpoint.acknowledgedSeq + 1) {
      this.bufferEvent(event, frameBytes);
      if (event.channel === "session") {
        await markSessionSyncing(this.record.peonId, this.generation);
        this.requestSnapshot();
      } else {
        await markProjectSyncing(this.record.peonId, this.generation);
        this.requestProjectSnapshot();
      }
      return;
    }
    await this.applyEvent(event);
  }

  private bufferEvent(event: DurableDeliveryEvent, frameBytes: number): void {
    const fingerprint = JSON.stringify(event);
    const buffered = this.bufferedEventFingerprints.get(event.deliveryCursor);
    if (buffered !== undefined) {
      if (buffered !== fingerprint) {
        throw new SessionSyncProtocolError("durable delivery cursor changed during catalog snapshots");
      }
      return;
    }
    // Draining requeues a blocked session with frameBytes=0 because the wire
    // frame is no longer available. Do not let repeated repair passes erase
    // the memory charge for that parsed event: otherwise each pass can admit
    // another full byte window until only the much looser item cap remains.
    this.bufferedBytes += frameBytes > 0 ? frameBytes : Buffer.byteLength(fingerprint);
    if (this.bufferedBytes > MAX_SNAPSHOT_BYTES) throw new SessionSyncProtocolError("catalog snapshot byte limit exceeded");
    if (this.bufferedEvents.length >= MAX_BUFFERED_EVENTS) throw new SessionSyncProtocolError("too many events during catalog snapshots");
    this.bufferedEvents.push(event);
    this.bufferedEventFingerprints.set(event.deliveryCursor, fingerprint);
  }

  private async applyEvent(event: DurableDeliveryEvent): Promise<void> {
    if (event.channel === "command") {
      const delivery = await reverseCommandGateway.commitDurableResult({
        workspaceId: this.record.workspaceId,
        peonId: this.record.peonId,
        socket: this.ws,
        syncGeneration: this.generation,
        durable: event,
      });
      if (this.checkpoint) this.checkpoint = { ...this.checkpoint, delivery };
      this.sendDeliveryAck(event.deliveryEpoch, delivery.acknowledgedCursor);
      return;
    }
    if (event.channel === "runtime") {
      const delivery = await commitRuntimeState({
        workspaceId: this.record.workspaceId,
        peonId: this.record.peonId,
        syncGeneration: this.generation,
        durable: event,
      });
      if (this.checkpoint) this.checkpoint = { ...this.checkpoint, delivery };
      this.sendDeliveryAck(event.deliveryEpoch, delivery.acknowledgedCursor);
      return;
    }
    const checkpoint = event.channel === "session" ? this.checkpoint?.catalog : this.projectCheckpoint?.catalog;
    // A catalog can be rebuilt independently of the shared durable outbox. In
    // that case the outbox may still contain events from the retired catalog
    // epoch. The authoritative snapshot/checkpoint for the epoch advertised in
    // hello supersedes those events, but their delivery cursors must still be
    // committed in order or one stale message poisons every reconnect.
    if (checkpoint && checkpoint.epoch !== event.catalogEpoch) {
      await this.commitSnapshotCoveredEvent(event);
      return;
    }
    let committed;
    try {
      committed = event.channel === "session" ? await applySocketSessionEvent({
        workspaceId: this.record.workspaceId,
        peonId: this.record.peonId,
        generation: this.generation,
        catalogEpoch: event.catalogEpoch,
        seq: event.seq,
        deliveryEpoch: event.deliveryEpoch,
        deliveryCursor: event.deliveryCursor,
        messageId: event.messageId,
        operation: event.operation,
        session: event.session,
        sessionId: event.sessionId,
      }) : await applySocketProjectEvent({
        workspaceId: this.record.workspaceId,
        peonId: this.record.peonId,
        generation: this.generation,
        catalogEpoch: event.catalogEpoch,
        seq: event.seq,
        deliveryEpoch: event.deliveryEpoch,
        deliveryCursor: event.deliveryCursor,
        messageId: event.messageId,
        operation: event.operation,
        project: event.project,
        projectId: event.projectId,
      });
    } catch (error) {
      throw new SessionSyncProtocolError(error instanceof Error ? error.message : `${event.channel} catalog commit failed`);
    }
    if (event.channel === "session") this.checkpoint = { catalog: committed.catalog, delivery: committed.delivery, previouslyReady: true };
    else {
      this.projectCheckpoint = { catalog: committed.catalog, previouslyReady: true };
      if (this.checkpoint) this.checkpoint = { ...this.checkpoint, delivery: committed.delivery };
    }
    this.sendCommittedAcks(event, committed);
  }

  private async maybeDrainBuffered(): Promise<void> {
    if (this.snapshot || this.projectSnapshot) return;
    const events = this.bufferedEvents;
    this.bufferedEvents = [];
    this.bufferedEventFingerprints.clear();
    this.bufferedBytes = 0;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.channel === "command" || event.channel === "runtime") {
        await this.applyEvent(event);
        continue;
      }
      const checkpoint = event.channel === "session" ? this.checkpoint?.catalog : this.projectCheckpoint?.catalog;
      if (!checkpoint) throw new SessionSyncProtocolError(`${event.channel} catalog event arrived before snapshot`);
      if (checkpoint.epoch === event.catalogEpoch && event.seq > checkpoint.acknowledgedSeq) {
        // A snapshot can race a replaceable event that was already queued in
        // the shared durable outbox. If that event still starts beyond the
        // freshly committed frontier, applying it would make the projection
        // throw a sequence-gap error and poison every reconnect. Keep the
        // delivery buffered and take another authoritative snapshot instead.
        if (event.seq > checkpoint.acknowledgedSeq + 1) {
          for (const pending of events.slice(index)) this.bufferEvent(pending, 0);
          if (event.channel === "session") {
            await markSessionSyncing(this.record.peonId, this.generation);
            this.requestSnapshot();
          } else {
            await markProjectSyncing(this.record.peonId, this.generation);
            this.requestProjectSnapshot();
          }
          return;
        }
        await this.applyEvent(event);
        continue;
      }
      await this.commitSnapshotCoveredEvent(event);
    }
  }

  private async commitSnapshotCoveredEvent(event: DurableCatalogEvent): Promise<void> {
    let committed;
    try {
      committed = event.channel === "session"
        ? await commitSnapshotCoveredSessionEvent({
          peonId: this.record.peonId, generation: this.generation, catalogEpoch: event.catalogEpoch, seq: event.seq,
          deliveryEpoch: event.deliveryEpoch, deliveryCursor: event.deliveryCursor, messageId: event.messageId,
        })
        : await commitSnapshotCoveredProjectEvent({
          peonId: this.record.peonId, generation: this.generation, catalogEpoch: event.catalogEpoch, seq: event.seq,
          deliveryEpoch: event.deliveryEpoch, deliveryCursor: event.deliveryCursor, messageId: event.messageId,
        });
    } catch (error) {
      throw new SessionSyncProtocolError(error instanceof Error ? error.message : "covered catalog event commit failed");
    }
    if (event.channel === "session") this.checkpoint = { catalog: committed.catalog, delivery: committed.delivery, previouslyReady: true };
    else {
      this.projectCheckpoint = { catalog: committed.catalog, previouslyReady: true };
      if (this.checkpoint) this.checkpoint = { ...this.checkpoint, delivery: committed.delivery };
    }
    this.sendCommittedAcks(event, committed);
  }

  private parseDurableEvent(message: Record<string, unknown>): DurableDeliveryEvent {
    if (message.capability === RUNTIME_STATE_CAPABILITY) {
      if (!this.additionalCapabilities.includes(RUNTIME_STATE_CAPABILITY)) {
        throw new SessionSyncProtocolError("runtime state capability not negotiated");
      }
      try {
        return parseDurableRuntimeState(message);
      } catch (error) {
        throw new SessionSyncProtocolError(error instanceof Error ? error.message : "invalid runtime state");
      }
    }
    if (message.capability === REVERSE_COMMAND_CAPABILITY) {
      if (!this.additionalCapabilities.includes(REVERSE_COMMAND_CAPABILITY)) {
        throw new SessionSyncProtocolError("reverse command capability not negotiated");
      }
      try {
        return parseDurableReverseCommandResult(message);
      } catch (error) {
        throw new SessionSyncProtocolError(
          error instanceof ReverseCommandProtocolError ? error.message : "invalid durable reverse command result",
        );
      }
    }
    const deliveryEpoch = requiredString(message.epoch, "epoch", 256);
    const deliveryCursor = requiredString(message.cursor, "cursor", 2_000);
    const messageId = requiredUuid(message.messageId, "messageId");
    if (!(["critical", "control", "normal", "bulk"] as unknown[]).includes(message.priority)) {
      throw new SessionSyncProtocolError("invalid durable priority");
    }
    if (!message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)) {
      throw new SessionSyncProtocolError("invalid durable payload");
    }
    const payload = message.payload as Record<string, unknown>;
    if (payload.type !== "session_catalog_event" && payload.type !== "project_catalog_event") {
      throw new SessionSyncProtocolError("unknown durable payload");
    }
    const catalogEpoch = requiredString(payload.epoch, "payload.epoch", 256);
    const seq = requiredSequence(payload.seq, "payload.seq");
    requiredSequence(payload.revision, "payload.revision");
    if (payload.type === "session_catalog_event") {
      const hasSession = payload.session !== undefined;
      const hasDeletion = payload.deletedSessionId !== undefined;
      if (hasSession === hasDeletion) throw new SessionSyncProtocolError("invalid session catalog event");
      return hasSession
        ? { channel: "session", deliveryEpoch, deliveryCursor, messageId, catalogEpoch, seq, operation: "upsert", session: parseSession(payload.session) }
        : { channel: "session", deliveryEpoch, deliveryCursor, messageId, catalogEpoch, seq, operation: "delete", sessionId: requiredString(payload.deletedSessionId, "deletedSessionId", 512) };
    }
    if (!this.projectCatalog) throw new SessionSyncProtocolError("project catalog capability not negotiated");
    const hasProject = payload.project !== undefined;
    const hasDeletion = payload.deletedProjectId !== undefined;
    if (hasProject === hasDeletion) throw new SessionSyncProtocolError("invalid project catalog event");
    return hasProject
      ? { channel: "project", deliveryEpoch, deliveryCursor, messageId, catalogEpoch, seq, operation: "upsert", project: parseProject(payload.project) }
      : { channel: "project", deliveryEpoch, deliveryCursor, messageId, catalogEpoch, seq, operation: "delete", projectId: requiredString(payload.deletedProjectId, "deletedProjectId", 512) };
  }

  private requireActiveRequest(message: Record<string, unknown>): CatalogSnapshot<PeonSession> {
    if (!this.snapshot || message.requestId !== this.snapshot.requestId) {
      throw new SessionSyncProtocolError("session catalog request mismatch");
    }
    return this.snapshot;
  }

  private requireActiveProjectRequest(message: Record<string, unknown>): CatalogSnapshot<PeonProject> {
    if (!this.projectSnapshot || message.requestId !== this.projectSnapshot.requestId) {
      throw new SessionSyncProtocolError("project catalog request mismatch");
    }
    return this.projectSnapshot;
  }

  private sendCommittedAcks(event: DurableCatalogEvent, committed: {
    catalog: { epoch: string; acknowledgedSeq: number };
    delivery: { epoch: string; acknowledgedCursor: string };
  }): void {
    this.sendDeliveryAck(event.deliveryEpoch, committed.delivery.acknowledgedCursor);
    this.send({ type: `${event.channel}_catalog_ack`, epoch: committed.catalog.epoch, acknowledgedSeq: committed.catalog.acknowledgedSeq });
  }

  private sendDeliveryAck(epoch: string, cumulativeCursor: string): void {
    this.send({ type: "durable_ack", epoch, cursor: cumulativeCursor });
  }

  private armTimer(channel: DurableCatalogEvent["channel"]): void {
    const current = channel === "session" ? this.sessionTimer : this.projectTimer;
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      const snapshot = channel === "session" ? this.snapshot : this.projectSnapshot;
      if (this.disposed || this.ws.readyState !== WebSocket.OPEN || !snapshot) return;
      this.send({ type: `${channel}_catalog_snapshot_cancel`, requestId: snapshot.requestId });
      this.ws.close(1011, "catalog sync timeout");
    }, SYNC_TIMEOUT_MS);
    timer.unref();
    if (channel === "session") this.sessionTimer = timer;
    else this.projectTimer = timer;
  }

  private send(frame: Record<string, unknown>): void {
    if (this.disposed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }
}

// Compatibility export for code compiled against the first single-catalog
// implementation. New call sites should use PeonCatalogSync.
export { PeonCatalogSync as PeonSessionSync };

export function parseSessionCatalogHello(frame: Record<string, unknown>): {
  catalog: CatalogHello;
  projectCatalog: CatalogHello | null;
  delivery: DeliveryHello;
} {
  if (!frame.channels || typeof frame.channels !== "object" || Array.isArray(frame.channels)) {
    throw new SessionSyncProtocolError("missing session catalog channel state");
  }
  const channel = (frame.channels as Record<string, unknown>)[SESSION_CATALOG_CAPABILITY];
  if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
    throw new SessionSyncProtocolError("missing session catalog channel state");
  }
  if (!frame.delivery || typeof frame.delivery !== "object" || Array.isArray(frame.delivery)) {
    throw new SessionSyncProtocolError("missing durable delivery state");
  }
  const c = channel as Record<string, unknown>;
  const d = frame.delivery as Record<string, unknown>;
  const earliestSeq = requiredSequence(c.earliestSeq, "earliestSeq");
  const latestSeq = requiredSequence(c.latestSeq, "latestSeq");
  if (earliestSeq > latestSeq + 1) throw new SessionSyncProtocolError("invalid catalog sequence range");
  const pendingMessages = requiredSequence(d.pendingMessages, "pendingMessages");
  const pendingBytes = requiredSequence(d.pendingBytes, "pendingBytes");
  const maxMessages = requiredPositiveSequence(d.maxMessages, "maxMessages");
  const maxBytes = requiredPositiveSequence(d.maxBytes, "maxBytes");
  if (pendingMessages > maxMessages || pendingBytes > maxBytes) throw new SessionSyncProtocolError("invalid delivery capacity state");
  requiredBoolean(d.backpressured, "backpressured");
  // This is Peon's status from before the current hello_ack. It is expected to
  // be false on first negotiation and must not be used to decide whether
  // Overseer accepts the advertised durable-delivery capability.
  requiredBoolean(d.negotiated, "negotiated");
  requiredBoolean(d.recoveredFromCorruption, "recoveredFromCorruption");
  const acknowledgedCursor = optionalString(d.acknowledgedCursor, "acknowledgedCursor", 2_000);
  optionalString(d.lastError, "lastError", 2_000);
  const earliestCursor = optionalString(d.earliestCursor, "earliestCursor", 2_000);
  const latestCursor = optionalString(d.latestCursor, "latestCursor", 2_000);
  if (pendingMessages > 0 && (!earliestCursor || !latestCursor)) throw new SessionSyncProtocolError("missing pending delivery cursor range");
  const channels = frame.channels as Record<string, unknown>;
  const rawProject = channels[PROJECT_CATALOG_CAPABILITY];
  let projectCatalog: CatalogHello | null = null;
  if (rawProject !== undefined) {
    if (!rawProject || typeof rawProject !== "object" || Array.isArray(rawProject)) {
      throw new SessionSyncProtocolError("invalid project catalog channel state");
    }
    const project = rawProject as Record<string, unknown>;
    const projectEarliestSeq = requiredSequence(project.earliestSeq, "project earliestSeq");
    const projectLatestSeq = requiredSequence(project.latestSeq, "project latestSeq");
    if (projectEarliestSeq > projectLatestSeq + 1) throw new SessionSyncProtocolError("invalid project catalog sequence range");
    projectCatalog = {
      epoch: requiredString(project.epoch, "project catalog epoch", 256),
      revision: requiredSequence(project.revision, "project revision"),
      earliestSeq: projectEarliestSeq,
      latestSeq: projectLatestSeq,
    };
  }
  return {
    catalog: {
      epoch: requiredString(c.epoch, "catalog epoch", 256),
      revision: requiredSequence(c.revision, "revision"),
      earliestSeq,
      latestSeq,
    },
    projectCatalog,
    delivery: {
      epoch: requiredString(d.epoch, "delivery epoch", 256),
      earliestCursor,
      latestCursor,
      acknowledgedCursor,
      pendingMessages,
    },
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new SessionSyncProtocolError(`invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new SessionSyncProtocolError(`invalid ${field}`);
  return value;
}

function requiredSequence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionSyncProtocolError(`invalid ${field}`);
  }
  return value;
}

function requiredPositiveSequence(value: unknown, field: string): number {
  const parsed = requiredSequence(value, field);
  if (parsed === 0) throw new SessionSyncProtocolError(`invalid ${field}`);
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new SessionSyncProtocolError(`invalid ${field}`);
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const string = requiredString(value, field, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(string)) {
    throw new SessionSyncProtocolError(`invalid ${field}`);
  }
  return string;
}

function optionalTime(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new SessionSyncProtocolError(`invalid ${field}`);
  return value;
}

function parseSession(value: unknown): PeonSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionSyncProtocolError("invalid session summary");
  const session = value as Record<string, unknown>;
  return {
    id: requiredString(session.id, "session.id", 512),
    status: optionalString(session.status, "session.status", 64),
    projectKey: optionalString(session.projectKey, "session.projectKey", 512),
    projectId: optionalString(session.projectId, "session.projectId", 512),
    title: optionalString(session.title, "session.title", 2_000),
    promptPreview: optionalString(session.promptPreview, "session.promptPreview", 2_000),
    lastMessagePreview: optionalString(session.lastMessagePreview, "session.lastMessagePreview", 2_000),
    initiator: optionalString(session.initiator, "session.initiator", 512),
    outcome: session.outcome ?? null,
    startedAt: optionalTime(session.startedAt, "session.startedAt"),
    endedAt: optionalTime(session.endedAt, "session.endedAt"),
    lastActivityAt: optionalTime(session.lastActivityAt, "session.lastActivityAt"),
  };
}

function parseProject(value: unknown): PeonProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionSyncProtocolError("invalid project summary");
  const project = value as Record<string, unknown>;
  const projectId = requiredString(project.projectId, "project.projectId", 512);
  const key = requiredString(project.key, "project.key", 512);
  const name = optionalString(project.name ?? project.label, "project.name", 2_000);
  const dir = optionalString(project.dir ?? project.path, "project.dir", 4_096);
  const metadata = optionalString(project.metadata, "project.metadata", 32_000);
  const quickLinks = normalizeProjectQuickLinks(project.quickLinks);
  // Validated but not yet projected: Peon 0.12.0 archives projects locally and
  // Overseer has no archive surface for it.
  optionalTime(project.archivedAt, "project.archivedAt");
  // Unknown fields are ignored rather than fatal, as in parseSession. A summary
  // is a projection of fields Overseer understands, and a newer Peon adding one
  // must not take its socket down on every reconnect.
  return { projectId, key, name, dir, metadata, quickLinks };
}
