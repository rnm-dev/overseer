import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import { sessionWarnings } from "../../../sessions/index.js";
import type { SessionWarning } from "../../../sessions/index.js";

export const SESSION_WARNING_CAPABILITY = "session-warning-v1";

export class SessionWarningChannel implements PeonSocketChannel {
  readonly capability = SESSION_WARNING_CAPABILITY;
  private sender: PeonSocketSender | null = null;
  private accepted = false;
  private unsubscribe: (() => void) | null = null;

  helloState(): PeonSocketFrame {
    return {};
  }

  // The durable outbox remembers its own negotiation across restarts, but not
  // which optional feature channels the peer accepted. Wait for this channel's
  // explicit hello acknowledgement before producing new warning frames.
  started(_sender: PeonSocketSender): void {}

  connecting(): void {}

  negotiated(accepted: boolean, _acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    this.accepted = accepted;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.sender = accepted ? sender : null;
    if (accepted) this.activate(sender);
  }

  disconnected(resetAuthority: boolean): void {
    if (!resetAuthority && this.sender?.durable) return;
    this.accepted = false;
    this.sender = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  handles(_frame: PeonSocketFrame): boolean {
    return false;
  }

  receive(_frame: PeonSocketFrame, _sender: PeonSocketSender): void {}

  private activate(sender: PeonSocketSender): void {
    this.sender = sender;
    this.accepted = true;
    this.unsubscribe?.();
    this.unsubscribe = sessionWarnings.subscribe((warning) => this.send(warning));
  }

  private send(warning: SessionWarning): void {
    const sender = this.sender;
    if (!sender || !this.accepted) return;
    const result = sender.sendDurable(warning, {
      priority: "control",
      capability: this.capability,
      dedupeKey: `session-warning:${warning.sessionId}:${warning.code}:${warning.logPath ?? warning.source ?? "session"}:${warning.currentBytes ?? warning.currentTokens ?? 0}`,
    });
    if (!result.accepted) sender.disconnect("session warning durable outbox is backpressured");
  }
}
