import assert from "node:assert/strict";
import test from "node:test";
import type { PeonSocketDurableOptions, PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import { SessionWarningChannel } from "../overseer/socket/channels/sessionWarningChannel.js";
import { sessionWarnings } from "../sessions/sessionWarnings.js";

test("session warnings use the negotiated durable socket channel", () => {
  const frames: PeonSocketFrame[] = [];
  const options: PeonSocketDurableOptions[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    send: () => false,
    sendBinary: () => false,
    sendDurable(frame, durableOptions) {
      frames.push(frame);
      options.push(durableOptions ?? {});
      return { accepted: true, epoch: "epoch", cursor: "cursor", messageId: "message" };
    },
    disconnect(reason) { throw new Error(reason); },
  };
  const channel = new SessionWarningChannel();
  channel.negotiated(true, { capabilities: [channel.capability] }, sender);
  sessionWarnings.publish({
    type: "session_warning",
    sessionId: "session-1",
    code: "payload_near_limit",
    currentBytes: 700,
    limitBytes: 1_000,
    message: "near limit",
  });
  channel.disconnected(true);
  assert.deepEqual(frames, [{
    type: "session_warning",
    sessionId: "session-1",
    code: "payload_near_limit",
    currentBytes: 700,
    limitBytes: 1_000,
    message: "near limit",
  }]);
  assert.equal(options[0]?.priority, "control");
  assert.match(options[0]?.dedupeKey ?? "", /session-warning:session-1:payload_near_limit/);
});

test("an unnegotiated warning channel does not emit frames", () => {
  const frames: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: false,
    send: (frame) => { frames.push(frame); return true; },
    sendBinary: () => true,
    sendDurable: () => ({ accepted: false, code: "PERSIST_FAILED", error: "unexpected" }),
    disconnect(reason) { throw new Error(reason); },
  };
  const channel = new SessionWarningChannel();
  channel.negotiated(false, {}, sender);
  sessionWarnings.publish({ type: "session_warning", sessionId: "session-2", code: "context_near_limit", message: "near" });
  assert.deepEqual(frames, []);
});
