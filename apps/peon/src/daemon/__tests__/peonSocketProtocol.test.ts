import assert from "node:assert/strict";
import test from "node:test";
import { PeonSocketMultiplexer, type PeonSocketChannel, type PeonSocketFrame } from "../overseer/socket/peonSocketProtocol.js";

test("multiplexer advertises, negotiates, and routes isolated channels", () => {
  const calls: string[] = [];
  const channel: PeonSocketChannel = {
    capability: "example-v1",
    helloState: () => ({ cursor: 4 }),
    started: () => calls.push("started"),
    connecting: () => calls.push("connecting"),
    negotiated: (accepted) => calls.push(`negotiated:${accepted}`),
    disconnected: (reset) => calls.push(`disconnected:${reset}`),
    handles: (frame) => frame.type === "example_event",
    receive: (frame) => calls.push(`received:${frame.value}`),
  };
  const mux = new PeonSocketMultiplexer([channel]);
  assert.deepEqual(mux.hello(1), {
    type: "hello",
    protocol: 1,
    capabilities: ["example-v1"],
    channels: { "example-v1": { cursor: 4 } },
  });
  assert.equal(mux.hello(1, { peonId: "peon-a" }).peonId, "peon-a");
  const sender = {
    durable: false,
    send: (_frame: PeonSocketFrame) => true,
    sendBinary: () => true,
    sendDurable: () => ({ accepted: false as const, code: "PERSIST_FAILED" as const, error: "disabled" }),
    disconnect: (_reason: string) => {},
  };
  mux.started(sender);
  mux.connecting();
  mux.negotiated({ capabilities: ["example-v1"] }, sender);
  assert.equal(mux.receive({ type: "example_event", value: 7 }, sender), true);
  assert.equal(mux.receive({ type: "unknown" }, sender), false);
  mux.disconnected(true);
  assert.deepEqual(calls, ["started", "connecting", "negotiated:true", "received:7", "disconnected:true"]);
});
