export const PEON_SOCKET_MAX_FRAME_BYTES = 1024 * 1024;
export class PeonSocketMultiplexer {
    channels;
    constructor(channels) {
        this.channels = channels;
    }
    hello(protocol, identity = {}) {
        if (this.channels.length === 0)
            return { type: "hello", protocol, ...identity };
        const capabilities = [...new Set(this.channels.map((channel) => channel.capability))];
        return {
            type: "hello",
            protocol,
            ...identity,
            capabilities,
            channels: Object.fromEntries(this.channels.map((channel) => [channel.capability, channel.helloState()])),
        };
    }
    negotiated(acknowledgement, sender) {
        const accepted = Array.isArray(acknowledgement.capabilities)
            ? new Set(acknowledgement.capabilities.filter((value) => typeof value === "string"))
            : new Set();
        for (const channel of this.channels) {
            channel.negotiated(accepted.has(channel.capability), acknowledgement, sender);
        }
    }
    started(sender) {
        for (const channel of this.channels)
            channel.started(sender);
    }
    connecting() {
        for (const channel of this.channels)
            channel.connecting();
    }
    receive(frame, sender) {
        const channel = this.channels.find((candidate) => candidate.handles(frame));
        if (!channel)
            return false;
        channel.receive(frame, sender);
        return true;
    }
    receiveBinary(frame, sender) {
        const channel = this.channels.find((candidate) => candidate.handlesBinary?.(frame));
        if (!channel?.receiveBinary)
            return false;
        channel.receiveBinary(frame, sender);
        return true;
    }
    disconnected(resetAuthority = false) {
        for (const channel of this.channels)
            channel.disconnected(resetAuthority);
    }
    durableAcknowledged(cursor) {
        for (const channel of this.channels)
            channel.durableAcknowledged?.(cursor);
    }
    durableAcknowledging(cursor) {
        return this.channels.every((channel) => channel.durableAcknowledging?.(cursor) !== false);
    }
}
