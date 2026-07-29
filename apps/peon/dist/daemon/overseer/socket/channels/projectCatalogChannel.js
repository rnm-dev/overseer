import { PROJECT_CATALOG_CAPABILITY, ProjectCatalogError, projectCatalog, } from "../../../projects/index.js";
const FRAME_TYPES = new Set([
    "project_catalog_snapshot_request",
    "project_catalog_snapshot_cancel",
    "project_catalog_ack",
]);
const PROJECT_CATALOG_ACK_RETRY_MS = 10_000;
function stringField(frame, key) {
    const value = frame[key];
    return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}
export class ProjectCatalogChannel {
    catalog;
    ackRetryMs;
    capability = PROJECT_CATALOG_CAPABILITY;
    sender = null;
    accepted = false;
    unsubscribe = null;
    ackRetryTimer = null;
    constructor(catalog = projectCatalog, ackRetryMs = PROJECT_CATALOG_ACK_RETRY_MS) {
        this.catalog = catalog;
        this.ackRetryMs = ackRetryMs;
    }
    helloState() {
        return { ...this.catalog.state() };
    }
    started(_sender) { }
    connecting() { }
    negotiated(accepted, acknowledgement, sender) {
        const active = accepted && sender.durable;
        this.sender = active ? sender : null;
        this.accepted = active;
        this.unsubscribe?.();
        this.unsubscribe = active ? this.catalog.subscribe((event) => {
            if (!this.sendEvent(event))
                sender.disconnect("project catalog backpressure limit exceeded");
            this.scheduleAckRetry();
        }) : null;
        if (!accepted)
            return;
        if (!sender.durable) {
            sender.disconnect("project catalog requires durable-delivery-v1");
            return;
        }
        const channelState = acknowledgement.channels?.[this.capability];
        if (!channelState || typeof channelState !== "object" || Array.isArray(channelState))
            return;
        const state = channelState;
        const local = this.catalog.state();
        if (state.epoch !== local.epoch || !Number.isSafeInteger(state.acknowledgedSeq))
            return;
        const acknowledgedSeq = state.acknowledgedSeq;
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
        }
        catch {
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
    disconnected(resetAuthority) {
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
    handles(frame) {
        return typeof frame.type === "string" && FRAME_TYPES.has(frame.type);
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("unnegotiated project catalog frame");
        if (frame.type === "project_catalog_ack") {
            const local = this.catalog.state();
            try {
                if (frame.epoch !== local.epoch || !this.catalog.acknowledge(frame.acknowledgedSeq)) {
                    return this.error(sender, null, "BAD_CURSOR", "invalid project catalog acknowledgement");
                }
            }
            catch {
                sender.disconnect("project catalog acknowledgement persistence failed");
            }
            this.scheduleAckRetry();
            return;
        }
        const requestId = stringField(frame, "requestId");
        if (!requestId)
            return this.error(sender, null, "BAD_REQUEST", "requestId is required");
        if (frame.type === "project_catalog_snapshot_cancel") {
            this.catalog.cancel(requestId);
            this.sendOrDisconnect(sender, { type: "project_catalog_snapshot_cancelled", requestId });
            return;
        }
        const cursor = frame.cursor === undefined ? undefined : stringField(frame, "cursor");
        if (frame.cursor !== undefined && !cursor)
            return this.error(sender, requestId, "BAD_CURSOR", "invalid project catalog cursor");
        try {
            const page = this.catalog.page(requestId, frame.limit, cursor ?? undefined);
            if (!sender.send({ type: "project_catalog_snapshot_page", ...page })) {
                sender.disconnect("project catalog backpressure limit exceeded");
            }
            else if (!page.hasMore) {
                // A fresh snapshot may be the first exchange after negotiation, so no
                // resume replay has armed the channel-ack timer yet. Once the final
                // barrier page is on the wire, retry retained events until Overseer
                // durably acknowledges the snapshot barrier. Dedupe keeps events that
                // are still in the global outbox from consuming another cursor.
                this.scheduleAckRetry();
            }
        }
        catch (error) {
            if (error instanceof ProjectCatalogError)
                return this.error(sender, requestId, error.code, error.message);
            throw error;
        }
    }
    sendEvent(event) {
        const sender = this.sender;
        if (!sender)
            return false;
        const epoch = this.catalog.state().epoch;
        return sender.sendDurable({ type: "project_catalog_event", epoch, ...event }, {
            priority: "normal",
            capability: this.capability,
            dedupeKey: `project-catalog:${epoch}:${event.seq}`,
        }).accepted;
    }
    scheduleAckRetry() {
        this.clearAckRetry();
        if (!this.accepted || !this.sender)
            return;
        const state = this.catalog.state();
        const pending = this.catalog.eventsAfter(state.earliestSeq - 1);
        if (!pending || pending.length === 0)
            return;
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
    clearAckRetry() {
        if (this.ackRetryTimer)
            clearTimeout(this.ackRetryTimer);
        this.ackRetryTimer = null;
    }
    error(sender, requestId, code, message) {
        this.sendOrDisconnect(sender, { type: "project_catalog_error", requestId, code, error: message });
    }
    sendOrDisconnect(sender, frame) {
        if (!sender.send(frame))
            sender.disconnect("project catalog backpressure limit exceeded");
    }
}
