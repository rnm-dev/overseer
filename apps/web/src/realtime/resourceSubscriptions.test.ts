import assert from "node:assert/strict";
import test from "node:test";
import { ResourceSubscriptions } from "./resourceSubscriptions";

test("resource subscriptions share one socket subscription and stop at the final listener", () => {
  const sent: Array<Record<string, unknown>> = [];
  const manager = new ResourceSubscriptions();
  manager.connect((message) => sent.push(message as Record<string, unknown>), true);
  const samples: unknown[] = [];
  const first = manager.subscribe("peon-1", (sample) => samples.push(sample));
  const second = manager.subscribe("peon-1", (sample) => samples.push(sample));
  assert.equal(sent.filter((message) => message.type === "resources:subscribe").length, 1);
  const subscriptionId = sent[0].subscriptionId;
  manager.handle({ type: "resources:sample", subscriptionId, sample: { sampledAt: 1 } });
  assert.equal(samples.length, 2);
  first();
  assert.equal(sent.filter((message) => message.type === "resources:unsubscribe").length, 0);
  second();
  assert.equal(sent.filter((message) => message.type === "resources:unsubscribe").length, 1);
});
