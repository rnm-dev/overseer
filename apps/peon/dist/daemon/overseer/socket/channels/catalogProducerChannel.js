function stringField(frame, key) {
    const value = frame[key];
    return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}
/** Shared producer transport; each adapter owns its authority and wire rows. */
export class CatalogProducerChannel {
    options;
    capability;
    sender = null;
    accepted = false;
    unsubscribe = null;
    retryTimer = null;
    constructor(options) {
        this.options = options;
        this.capability = options.capability;
        options.start?.();
    }
    helloState() {
        return { ...this.options.catalog.state() };
    }
    started(_sender) { }
    connecting() { }
    negotiated(accepted, acknowledgement, sender) {
        const active = accepted && sender.durable;
        this.sender = active ? sender : null;
        this.accepted = active;
        this.unsubscribe?.();
        this.unsubscribe = active ? this.options.catalog.subscribe((event) => {
            if (!this.sendEvent(event))
                sender.disconnect(`${this.options.label} backpressure limit exceeded`);
            this.scheduleRetry();
        }) : null;
        if (!accepted)
            return;
        if (!sender.durable) {
            sender.disconnect(`${this.options.label} requires durable-delivery-v1`);
            return;
        }
        const channelState = acknowledgement.channels?.[this.capability];
        if (!channelState || typeof channelState !== "object" || Array.isArray(channelState))
            return;
        const state = channelState;
        const local = this.options.catalog.state();
        if (state.epoch !== local.epoch || !Number.isSafeInteger(state.acknowledgedSeq))
            return;
        const acknowledgedSeq = state.acknowledgedSeq;
        const replay = this.options.catalog.eventsAfter(acknowledgedSeq);
        if (!replay) {
            this.sendOrDisconnect(sender, { type: `${this.options.prefix}_error`, code: "CURSOR_UNAVAILABLE", epoch: local.epoch });
            return;
        }
        const acknowledged = this.acknowledge(acknowledgedSeq, sender);
        if (acknowledged !== true) {
            if (acknowledged === false && this.options.acknowledgementRejected)
                sender.disconnect(this.options.acknowledgementRejected);
            return;
        }
        for (const event of replay) {
            if (!this.sendEvent(event)) {
                sender.disconnect(`${this.options.label} durable replay is backpressured`);
                break;
            }
        }
        this.scheduleRetry();
    }
    disconnected(resetAuthority) {
        const keepDurableProducer = !resetAuthority && this.sender?.durable === true;
        if (!keepDurableProducer) {
            this.sender = null;
            this.accepted = false;
            this.unsubscribe?.();
            this.unsubscribe = null;
            this.clearRetry();
        }
        this.options.catalog.cancelActiveSnapshot();
    }
    handles(frame) {
        return frame.type === `${this.options.prefix}_snapshot_request`
            || frame.type === `${this.options.prefix}_snapshot_cancel`
            || frame.type === `${this.options.prefix}_ack`;
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect(`unnegotiated ${this.options.label} frame`);
        if (frame.type === `${this.options.prefix}_ack`) {
            const local = this.options.catalog.state();
            const acknowledged = frame.epoch === local.epoch ? this.acknowledge(frame.acknowledgedSeq, sender) : false;
            if (acknowledged === null) {
                this.scheduleRetry();
                return;
            }
            if (!acknowledged) {
                this.error(sender, null, "BAD_CURSOR", `invalid ${this.options.label} acknowledgement`);
                return;
            }
            this.scheduleRetry();
            return;
        }
        const requestId = stringField(frame, "requestId");
        if (!requestId)
            return this.error(sender, null, "BAD_REQUEST", "requestId is required");
        if (frame.type === `${this.options.prefix}_snapshot_cancel`) {
            this.options.catalog.cancel(requestId);
            this.sendOrDisconnect(sender, { type: `${this.options.prefix}_snapshot_cancelled`, requestId });
            return;
        }
        const cursor = frame.cursor === undefined ? undefined : stringField(frame, "cursor");
        if (frame.cursor !== undefined && !cursor)
            return this.error(sender, requestId, "BAD_CURSOR", `invalid ${this.options.label} cursor`);
        try {
            const page = this.options.catalog.page(requestId, frame.limit, cursor ?? undefined);
            if (!sender.send(this.options.pageFrame(page))) {
                sender.disconnect(`${this.options.label} backpressure limit exceeded`);
            }
            else if (!page.hasMore) {
                this.scheduleRetry();
            }
        }
        catch (caught) {
            const error = this.options.error(caught);
            if (error)
                return this.error(sender, requestId, error.code, error.message);
            throw caught;
        }
    }
    acknowledge(seq, sender) {
        try {
            if (this.options.catalog.acknowledge(seq))
                return true;
        }
        catch {
            if (this.options.acknowledgementFailure)
                sender.disconnect(this.options.acknowledgementFailure);
            return null;
        }
        return false;
    }
    sendEvent(event) {
        const sender = this.sender;
        if (!sender)
            return false;
        const epoch = this.options.catalog.state().epoch;
        return sender.sendDurable(this.options.eventFrame(event, epoch), {
            priority: "normal",
            capability: this.capability,
            ...this.options.eventOptions(event, epoch),
        }).accepted;
    }
    scheduleRetry() {
        if (!this.options.retry)
            return;
        this.clearRetry();
        if (!this.accepted || !this.sender)
            return;
        const state = this.options.catalog.state();
        const pending = this.options.catalog.eventsAfter(state.earliestSeq - 1);
        if (!pending || pending.length === 0)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            const current = this.options.catalog.state();
            for (const event of this.options.catalog.eventsAfter(current.earliestSeq - 1) ?? []) {
                if (!this.sendEvent(event)) {
                    this.sender?.disconnect(`${this.options.label} acknowledgement retry is backpressured`);
                    break;
                }
            }
            this.scheduleRetry();
        }, this.options.retry.delayMs);
        this.retryTimer.unref();
    }
    clearRetry() {
        if (this.retryTimer)
            clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }
    error(sender, requestId, code, message) {
        this.sendOrDisconnect(sender, { type: `${this.options.prefix}_error`, requestId, code, error: message });
    }
    sendOrDisconnect(sender, frame) {
        if (!sender.send(frame))
            sender.disconnect(`${this.options.label} backpressure limit exceeded`);
    }
}
