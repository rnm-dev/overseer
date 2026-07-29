import { sessionWarnings } from "../../../sessionWarnings.js";
export const SESSION_WARNING_CAPABILITY = "session-warning-v1";
export class SessionWarningChannel {
    capability = SESSION_WARNING_CAPABILITY;
    sender = null;
    accepted = false;
    unsubscribe = null;
    helloState() {
        return {};
    }
    // The durable outbox remembers its own negotiation across restarts, but not
    // which optional feature channels the peer accepted. Wait for this channel's
    // explicit hello acknowledgement before producing new warning frames.
    started(_sender) { }
    connecting() { }
    negotiated(accepted, _acknowledgement, sender) {
        this.accepted = accepted;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.sender = accepted ? sender : null;
        if (accepted)
            this.activate(sender);
    }
    disconnected(resetAuthority) {
        if (!resetAuthority && this.sender?.durable)
            return;
        this.accepted = false;
        this.sender = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
    handles(_frame) {
        return false;
    }
    receive(_frame, _sender) { }
    activate(sender) {
        this.sender = sender;
        this.accepted = true;
        this.unsubscribe?.();
        this.unsubscribe = sessionWarnings.subscribe((warning) => this.send(warning));
    }
    send(warning) {
        const sender = this.sender;
        if (!sender || !this.accepted)
            return;
        const result = sender.sendDurable(warning, {
            priority: "control",
            capability: this.capability,
            dedupeKey: `session-warning:${warning.sessionId}:${warning.code}:${warning.logPath ?? warning.source ?? "session"}:${warning.currentBytes ?? warning.currentTokens ?? 0}`,
        });
        if (!result.accepted)
            sender.disconnect("session warning durable outbox is backpressured");
    }
}
