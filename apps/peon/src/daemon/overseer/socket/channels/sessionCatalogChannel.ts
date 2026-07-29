import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import {
  SESSION_CATALOG_CAPABILITY,
  SessionCatalogError,
  sessionCatalog,
  type SessionCatalog,
  type SessionCatalogEvent,
} from "../../../sessionCatalog.js";

const FRAME_TYPES = new Set([
  "session_catalog_snapshot_request",
  "session_catalog_snapshot_cancel",
  "session_catalog_ack",
]);

function stringField(frame: PeonSocketFrame, key: string): string | null {
  const value = frame[key];
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}

export class SessionCatalogChannel implements PeonSocketChannel {
  readonly capability = SESSION_CATALOG_CAPABILITY;
  private sender: PeonSocketSender | null = null;
  private accepted = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly catalog: SessionCatalog = sessionCatalog) {
    catalog.start();
  }

  helloState(): PeonSocketFrame {
    return { ...this.catalog.state() };
  }

  // Durable-delivery negotiation survives restart, but acceptance of this
  // optional channel does not. Wait for the explicit hello acknowledgement;
  // the required snapshot recovers any catalog changes made before reconnect.
  started(_sender: PeonSocketSender): void {}

  connecting(): void {}

  negotiated(accepted: boolean, acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    const active = accepted && sender.durable;
    this.sender = active ? sender : null;
    this.accepted = active;
    this.unsubscribe?.();
    this.unsubscribe = active ? this.catalog.subscribe((event) => {
      if (!this.sendEvent(event)) sender.disconnect("session catalog backpressure limit exceeded");
    }) : null;
    if (!accepted) return;
    if (!sender.durable) {
      sender.disconnect("session catalog requires durable-delivery-v1");
      return;
    }

    const channelState = (acknowledgement.channels as PeonSocketFrame | undefined)?.[this.capability];
    if (!channelState || typeof channelState !== "object" || Array.isArray(channelState)) return;
    const state = channelState as PeonSocketFrame;
    if (state.epoch !== this.catalog.epoch || !Number.isSafeInteger(state.acknowledgedSeq)) return;
    const acknowledgedSeq = state.acknowledgedSeq as number;
    const replay = this.catalog.eventsAfter(acknowledgedSeq);
    if (!replay) {
      this.sendOrDisconnect(sender, {
        type: "session_catalog_error",
        code: "CURSOR_UNAVAILABLE",
        epoch: this.catalog.epoch,
      });
      return;
    }
    this.catalog.acknowledge(acknowledgedSeq);
    for (const event of replay) {
      if (!this.sendEvent(event)) {
        sender.disconnect("session catalog durable replay is backpressured");
        break;
      }
    }
  }

  disconnected(resetAuthority: boolean): void {
    const keepDurableProducer = !resetAuthority && this.sender?.durable === true;
    if (!keepDurableProducer) {
      this.sender = null;
      this.accepted = false;
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
    this.catalog.cancelActiveSnapshot();
  }

  handles(frame: PeonSocketFrame): boolean {
    return typeof frame.type === "string" && FRAME_TYPES.has(frame.type);
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted) return sender.disconnect("unnegotiated session catalog frame");
    if (frame.type === "session_catalog_ack") {
      if (frame.epoch !== this.catalog.epoch || !this.catalog.acknowledge(frame.acknowledgedSeq as number)) {
        return this.error(sender, null, "BAD_CURSOR", "invalid session catalog acknowledgement");
      }
      return;
    }
    const requestId = stringField(frame, "requestId");
    if (!requestId) return this.error(sender, null, "BAD_REQUEST", "requestId is required");
    if (frame.type === "session_catalog_snapshot_cancel") {
      this.catalog.cancel(requestId);
      this.sendOrDisconnect(sender, { type: "session_catalog_snapshot_cancelled", requestId });
      return;
    }
    const cursor = frame.cursor === undefined ? undefined : stringField(frame, "cursor");
    if (frame.cursor !== undefined && !cursor) return this.error(sender, requestId, "BAD_CURSOR", "invalid session catalog cursor");
    try {
      const page = this.catalog.page(requestId, frame.limit, cursor ?? undefined);
      if (!sender.send({ type: "session_catalog_snapshot_page", ...page })) {
        sender.disconnect("session catalog backpressure limit exceeded");
      }
    } catch (error) {
      if (error instanceof SessionCatalogError) return this.error(sender, requestId, error.code, error.message);
      throw error;
    }
  }

  private sendEvent(event: SessionCatalogEvent): boolean {
    const sender = this.sender;
    if (!sender) return false;
    const frame = { type: "session_catalog_event", epoch: this.catalog.epoch, ...event };
    const sessionId = "session" in event ? event.session.id : event.deletedSessionId;
    return sender.sendDurable(frame, {
      priority: "normal",
      capability: this.capability,
      dedupeKey: `session-catalog:${this.catalog.epoch}:${event.seq}`,
      coalesceKey: `session-summary:${sessionId}`,
    }).accepted;
  }

  private error(sender: PeonSocketSender, requestId: string | null, code: string, message: string): void {
    this.sendOrDisconnect(sender, { type: "session_catalog_error", requestId, code, error: message });
  }

  private sendOrDisconnect(sender: PeonSocketSender, frame: PeonSocketFrame): void {
    if (!sender.send(frame)) sender.disconnect("session catalog backpressure limit exceeded");
  }
}
