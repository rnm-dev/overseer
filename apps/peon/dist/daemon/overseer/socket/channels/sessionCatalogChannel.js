import { SESSION_CATALOG_CAPABILITY, SessionCatalogError, sessionCatalog, } from "../../../sessions/index.js";
const FRAME_TYPES = new Set([
    "session_catalog_snapshot_request",
    "session_catalog_snapshot_cancel",
    "session_catalog_ack",
]);
function stringField(frame, key) {
    const value = frame[key];
    return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}
export class SessionCatalogChannel {
    catalog;
    capability = SESSION_CATALOG_CAPABILITY;
    sender = null;
    accepted = false;
    unsubscribe = null;
    constructor(catalog = sessionCatalog) {
        this.catalog = catalog;
        catalog.start();
    }
    helloState() {
        return { ...this.catalog.state() };
    }
    // Durable-delivery negotiation survives restart, but acceptance of this
    // optional channel does not. Wait for the explicit hello acknowledgement;
    // the required snapshot recovers any catalog changes made before reconnect.
    started(_sender) { }
    connecting() { }
    negotiated(accepted, acknowledgement, sender) {
        const active = accepted && sender.durable;
        this.sender = active ? sender : null;
        this.accepted = active;
        this.unsubscribe?.();
        this.unsubscribe = active ? this.catalog.subscribe((event) => {
            if (!this.sendEvent(event))
                sender.disconnect("session catalog backpressure limit exceeded");
        }) : null;
        if (!accepted)
            return;
        if (!sender.durable) {
            sender.disconnect("session catalog requires durable-delivery-v1");
            return;
        }
        const channelState = acknowledgement.channels?.[this.capability];
        if (!channelState || typeof channelState !== "object" || Array.isArray(channelState))
            return;
        const state = channelState;
        if (state.epoch !== this.catalog.epoch || !Number.isSafeInteger(state.acknowledgedSeq))
            return;
        const acknowledgedSeq = state.acknowledgedSeq;
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
    disconnected(resetAuthority) {
        const keepDurableProducer = !resetAuthority && this.sender?.durable === true;
        if (!keepDurableProducer) {
            this.sender = null;
            this.accepted = false;
            this.unsubscribe?.();
            this.unsubscribe = null;
        }
        this.catalog.cancelActiveSnapshot();
    }
    handles(frame) {
        return typeof frame.type === "string" && FRAME_TYPES.has(frame.type);
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("unnegotiated session catalog frame");
        if (frame.type === "session_catalog_ack") {
            if (frame.epoch !== this.catalog.epoch || !this.catalog.acknowledge(frame.acknowledgedSeq)) {
                return this.error(sender, null, "BAD_CURSOR", "invalid session catalog acknowledgement");
            }
            return;
        }
        const requestId = stringField(frame, "requestId");
        if (!requestId)
            return this.error(sender, null, "BAD_REQUEST", "requestId is required");
        if (frame.type === "session_catalog_snapshot_cancel") {
            this.catalog.cancel(requestId);
            this.sendOrDisconnect(sender, { type: "session_catalog_snapshot_cancelled", requestId });
            return;
        }
        const cursor = frame.cursor === undefined ? undefined : stringField(frame, "cursor");
        if (frame.cursor !== undefined && !cursor)
            return this.error(sender, requestId, "BAD_CURSOR", "invalid session catalog cursor");
        try {
            const page = this.catalog.page(requestId, frame.limit, cursor ?? undefined);
            if (!sender.send({ type: "session_catalog_snapshot_page", ...page })) {
                sender.disconnect("session catalog backpressure limit exceeded");
            }
        }
        catch (error) {
            if (error instanceof SessionCatalogError)
                return this.error(sender, requestId, error.code, error.message);
            throw error;
        }
    }
    sendEvent(event) {
        const sender = this.sender;
        if (!sender)
            return false;
        const frame = { type: "session_catalog_event", epoch: this.catalog.epoch, ...event };
        const sessionId = "session" in event ? event.session.id : event.deletedSessionId;
        return sender.sendDurable(frame, {
            priority: "normal",
            capability: this.capability,
            dedupeKey: `session-catalog:${this.catalog.epoch}:${event.seq}`,
            coalesceKey: `session-summary:${sessionId}`,
        }).accepted;
    }
    error(sender, requestId, code, message) {
        this.sendOrDisconnect(sender, { type: "session_catalog_error", requestId, code, error: message });
    }
    sendOrDisconnect(sender, frame) {
        if (!sender.send(frame))
            sender.disconnect("session catalog backpressure limit exceeded");
    }
}
