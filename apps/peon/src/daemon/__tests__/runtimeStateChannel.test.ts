import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeStateChannel } from "../overseer/socket/channels/runtimeStateChannel.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

function sender(sent: PeonSocketFrame[]): PeonSocketSender {
  return {
    durable: true,
    authority: "test",
    generation: 1,
    send: () => true,
    sendBinary: () => true,
    sendDurable: (frame) => {
      sent.push(frame);
      return { accepted: true, epoch: "delivery", cursor: String(sent.length), messageId: String(sent.length) };
    },
    disconnect: (reason) => assert.fail(reason),
  };
}

test("runtime-state-v1 publishes a bounded safe full projection and suppresses duplicates", () => {
  const frames: PeonSocketFrame[] = [];
  const channel = new RuntimeStateChannel();
  const transport = sender(frames);
  channel.started(transport);
  assert.equal(frames.length, 0, "state remains private until exact capability negotiation");
  channel.negotiated(true, {}, transport);
  const first = frames.at(-1)!;
  assert.equal(first.type, "runtime_state");
  assert.equal(first.protocol, 1);
  assert.match(String(first.digest), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes("overseerToken"), false);
  assert.equal(JSON.stringify(first).includes("fileTransferRoot"), false);

  const count = frames.length;
  channel.negotiated(true, {}, transport);
  assert.equal(frames.length, count + 1, "negotiation republishes the authoritative full state");
  channel.negotiated(false, {}, transport);
});

test("runtime-state-v1 advances revision after a relevant local settings change", () => {
  const frames: PeonSocketFrame[] = [];
  let paused = false;
  let changed: (() => void) | null = null;
  const channel = new RuntimeStateChannel(
    () => ({ paused, capacity: { active: 0, total: 0 }, daemon: { version: "test", revision: null }, providers: [], models: [] }),
    (listener) => { changed = listener; return () => { changed = null; }; },
  );
  const transport = sender(frames);
  channel.started(transport);
  channel.negotiated(true, {}, transport);
  const initialRevision = Number(frames.at(-1)!.revision);
  paused = true;
  changed?.();
  assert.ok(Number(frames.at(-1)!.revision) > initialRevision);
  assert.equal((frames.at(-1)!.state as PeonSocketFrame).paused, true);
});

test("runtime-state-v1 refuses an oversized projection before assigning a durable cursor", () => {
  const frames: PeonSocketFrame[] = [];
  let disconnected = "";
  const transport = sender(frames);
  transport.disconnect = (reason) => { disconnected = reason; };
  const channel = new RuntimeStateChannel(() => ({ models: ["x".repeat(56 * 1024)] }));

  channel.started(transport);
  channel.negotiated(true, {}, transport);

  assert.equal(frames.length, 0);
  assert.match(disconnected, /payload bound/);
});

test("runtime-state-v1 rejects sensitive keys recursively before durable publication", () => {
  const frames: PeonSocketFrame[] = [];
  let disconnected = "";
  const transport = sender(frames);
  transport.disconnect = (reason) => { disconnected = reason; };
  const channel = new RuntimeStateChannel(() => ({ providers: [{ nested: { credentials: "must-not-cross" } }] }));

  channel.started(transport);
  channel.negotiated(true, {}, transport);

  assert.equal(frames.length, 0);
  assert.match(disconnected, /forbidden sensitive key/);
});
