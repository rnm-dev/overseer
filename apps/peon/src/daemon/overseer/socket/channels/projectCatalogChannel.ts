import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import {
  PROJECT_CATALOG_CAPABILITY,
  ProjectCatalogError,
  projectCatalog,
  type ProjectCatalog,
  type ProjectCatalogEvent,
} from "../../../projects/index.js";

const FRAME_TYPES = new Set([
  "project_catalog_snapshot_request",
  "project_catalog_snapshot_cancel",
  "project_catalog_ack",
]);
const PROJECT_CATALOG_ACK_RETRY_MS = 10_000;

function stringField(frame: PeonSocketFrame, key: string): string | null {
  const value = frame[key];
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

export class ProjectCatalogChannel implements PeonSocketChannel {
  readonly capability = PROJECT_CATALOG_CAPABILITY;
  private sender: PeonSocketSender | null = null;
  private accepted = false;
  private unsubscribe: (() => void) | null = null;
  private ackRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly catalog: ProjectCatalog = projectCatalog,
    private readonly ackRetryMs = PROJECT_CATALOG_ACK_RETRY_MS,
  ) {}

  helloState(): PeonSocketFrame {
    return { ...this.catalog.state() };
  }

  started(_sender: PeonSocketSender): void {}

  connecting(): void {}

  negotiated(accepted: boolean, acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    const active = accepted && sender.durable;
    this.sender = active ? sender : null;
    this.accepted = active;
    this.unsubscribe?.();
    this.unsubscribe = active ? this.catalog.subscribe((event) => {
      if (!this.sendEvent(event)) sender.disconnect("project catalog backpressure limit exceeded");
      this.scheduleAckRetry();
    }) : null;
    if (!accepted) return;
    if (!sender.durable) {
      sender.disconnect("project catalog requires durable-delivery-v1");
      return;
    }

    const channelState = (acknowledgement.channels as PeonSocketFrame | undefined)?.[this.capability];
    if (!channelState || typeof channelState !== "object" || Array.isArray(channelState)) return;
    const state = channelState as PeonSocketFrame;
    const local = this.catalog.state();
    if (state.epoch !== local.epoch || !Number.isSafeInteger(state.acknowledgedSeq)) return;
    const acknowledgedSeq = state.acknowledgedSeq as number;
    const replay = this.catalog.eventsAfter(acknowledgedSeq);
    if (!replay) {
      this.sendOrDisconnect(sender, {
        type: "project_catalog_error",
        code: "CURSOR_UNAVAILABLE",
        epoch: local.epoch,
      });
      return;
    }
    try {
      if (!this.catalog.acknowledge(acknowledgedSeq)) {
        sender.disconnect("project catalog acknowledgement was rejected");
        return;
      }
    } catch {
      sender.disconnect("project catalog acknowledgement persistence failed");
      return;
    }
    for (const event of replay) {
      if (!this.sendEvent(event)) {
        sender.disconnect("project catalog durable replay is backpressured");
        break;
      }
    }
    this.scheduleAckRetry();
  }

  disconnected(resetAuthority: boolean): void {
    const keepDurableProducer = !resetAuthority && this.sender?.durable === true;
    if (!keepDurableProducer) {
      this.sender = null;
      this.accepted = false;
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.clearAckRetry();
    }
    this.catalog.cancelActiveSnapshot();
  }

  handles(frame: PeonSocketFrame): boolean {
    return typeof frame.type === "string" && FRAME_TYPES.has(frame.type);
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted) return sender.disconnect("unnegotiated project catalog frame");
    if (frame.type === "project_catalog_ack") {
      const local = this.catalog.state();
      try {
        if (frame.epoch !== local.epoch || !this.catalog.acknowledge(frame.acknowledgedSeq as number)) {
          return this.error(sender, null, "BAD_CURSOR", "invalid project catalog acknowledgement");
        }
      } catch {
        sender.disconnect("project catalog acknowledgement persistence failed");
      }
      this.scheduleAckRetry();
      return;
    }
    const requestId = stringField(frame, "requestId");
    if (!requestId) return this.error(sender, null, "BAD_REQUEST", "requestId is required");
    if (frame.type === "project_catalog_snapshot_cancel") {
      this.catalog.cancel(requestId);
      this.sendOrDisconnect(sender, { type: "project_catalog_snapshot_cancelled", requestId });
      return;
    }
    const cursor = frame.cursor === undefined ? undefined : stringField(frame, "cursor");
    if (frame.cursor !== undefined && !cursor) return this.error(sender, requestId, "BAD_CURSOR", "invalid project catalog cursor");
    try {
      const page = this.catalog.page(requestId, frame.limit, cursor ?? undefined);
      if (!sender.send({ type: "project_catalog_snapshot_page", ...page })) {
        sender.disconnect("project catalog backpressure limit exceeded");
      } else if (!page.hasMore) {
        // A fresh snapshot may be the first exchange after negotiation, so no
        // resume replay has armed the channel-ack timer yet. Once the final
        // barrier page is on the wire, retry retained events until Overseer
        // durably acknowledges the snapshot barrier. Dedupe keeps events that
        // are still in the global outbox from consuming another cursor.
        this.scheduleAckRetry();
      }
    } catch (error) {
      if (error instanceof ProjectCatalogError) return this.error(sender, requestId, error.code, error.message);
      throw error;
    }
  }

  private sendEvent(event: ProjectCatalogEvent): boolean {
    const sender = this.sender;
    if (!sender) return false;
    const epoch = this.catalog.state().epoch;
    return sender.sendDurable({ type: "project_catalog_event", epoch, ...event }, {
      priority: "normal",
      capability: this.capability,
      dedupeKey: `project-catalog:${epoch}:${event.seq}`,
    }).accepted;
  }

  private scheduleAckRetry(): void {
    this.clearAckRetry();
    if (!this.accepted || !this.sender) return;
    const state = this.catalog.state();
    const pending = this.catalog.eventsAfter(state.earliestSeq - 1);
    if (!pending || pending.length === 0) return;
    this.ackRetryTimer = setTimeout(() => {
      this.ackRetryTimer = null;
      const current = this.catalog.state();
      const replay = this.catalog.eventsAfter(current.earliestSeq - 1) ?? [];
      for (const event of replay) {
        if (!this.sendEvent(event)) {
          this.sender?.disconnect("project catalog acknowledgement retry is backpressured");
          break;
        }
      }
      this.scheduleAckRetry();
    }, this.ackRetryMs);
    this.ackRetryTimer.unref();
  }

  private clearAckRetry(): void {
    if (this.ackRetryTimer) clearTimeout(this.ackRetryTimer);
    this.ackRetryTimer = null;
  }

  private error(sender: PeonSocketSender, requestId: string | null, code: string, message: string): void {
    this.sendOrDisconnect(sender, { type: "project_catalog_error", requestId, code, error: message });
  }

  private sendOrDisconnect(sender: PeonSocketSender, frame: PeonSocketFrame): void {
    if (!sender.send(frame)) sender.disconnect("project catalog backpressure limit exceeded");
  }
}
