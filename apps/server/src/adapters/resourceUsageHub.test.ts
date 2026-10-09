import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import { ResourceUsageHub, type ResourceUsageClient } from "./resourceUsageHub.js";

test("resource usage subscribers share one upstream and the final unsubscribe aborts it", async () => {
  const messages: Array<Record<string, unknown>> = [];
  let opens = 0; let aborted = false; let push: ((chunk: string) => void) | undefined;
  const hub = new ResourceUsageHub((_ws, message) => messages.push(message as Record<string, unknown>), async () => ({
    identity: "workspace/peon", stream: async (chunk, signal) => { opens++; push = chunk; await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true })); },
  }));
  const client = (userId: string): ResourceUsageClient => ({ ws: {} as WebSocket, userId, actor: userId, workspaceId: "workspace", participant: null, closed: false });
  const a = client("a"); const b = client("b");
  await hub.subscribe(a, { subscriptionId: "a", peonId: "peon" });
  await hub.subscribe(b, { subscriptionId: "b", peonId: "peon" });
  assert.equal(opens, 1);
  push?.('event: sample\ndata: {"sampledAt":1}\n\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((message) => message.type === "resources:sample").length, 2);
  hub.unsubscribe(a, "a"); assert.equal(aborted, false);
  hub.unsubscribe(b, "b"); assert.equal(aborted, true);
});
