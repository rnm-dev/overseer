export type PeonSocketFrame = Record<string, unknown>;

export const PEON_SOCKET_MAX_FRAME_BYTES = 1024 * 1024;

export type PeonSocketPriority = "critical" | "control" | "normal" | "bulk";

export interface PeonSocketDurableOptions {
  priority?: PeonSocketPriority;
  capability?: string;
  dedupeKey?: string;
  coalesceKey?: string;
}

export type PeonSocketDurableResult =
  | { accepted: true; epoch: string; cursor: string; messageId: string }
  | { accepted: false; code: "OUTBOX_FULL" | "PERSIST_FAILED" | "INVALID_MESSAGE"; error: string };

export interface PeonSocketSender {
  readonly durable: boolean;
  send(frame: PeonSocketFrame): boolean;
  sendBinary(frame: Uint8Array): boolean;
  sendDurable(frame: PeonSocketFrame, options?: PeonSocketDurableOptions): PeonSocketDurableResult;
  disconnect(reason: string): void;
}

// A reverse-socket feature owns its frame namespace and lifecycle. The socket
// supervisor knows only how to connect, negotiate capabilities, and route
// frames; adding future Overseer features should not add feature logic there.
export interface PeonSocketChannel {
  readonly capability: string;
  helloState(): PeonSocketFrame;
  started(sender: PeonSocketSender): void;
  connecting(): void;
  negotiated(accepted: boolean, acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void;
  disconnected(resetAuthority: boolean): void;
  handles(frame: PeonSocketFrame): boolean;
  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void;
  durableAcknowledged?(cursor: string): void;
}

export class PeonSocketMultiplexer {
  constructor(private readonly channels: PeonSocketChannel[]) {}

  hello(protocol: number, identity: PeonSocketFrame = {}): PeonSocketFrame {
    if (this.channels.length === 0) return { type: "hello", protocol, ...identity };
    return {
      type: "hello",
      protocol,
      ...identity,
      capabilities: this.channels.map((channel) => channel.capability),
      channels: Object.fromEntries(this.channels.map((channel) => [channel.capability, channel.helloState()])),
    };
  }

  negotiated(acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    const accepted = Array.isArray(acknowledgement.capabilities)
      ? new Set(acknowledgement.capabilities.filter((value): value is string => typeof value === "string"))
      : new Set<string>();
    for (const channel of this.channels) {
      channel.negotiated(accepted.has(channel.capability), acknowledgement, sender);
    }
  }

  started(sender: PeonSocketSender): void {
    for (const channel of this.channels) channel.started(sender);
  }

  connecting(): void {
    for (const channel of this.channels) channel.connecting();
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): boolean {
    const channel = this.channels.find((candidate) => candidate.handles(frame));
    if (!channel) return false;
    channel.receive(frame, sender);
    return true;
  }

  disconnected(resetAuthority = false): void {
    for (const channel of this.channels) channel.disconnected(resetAuthority);
  }

  durableAcknowledged(cursor: string): void {
    for (const channel of this.channels) channel.durableAcknowledged?.(cursor);
  }
}
