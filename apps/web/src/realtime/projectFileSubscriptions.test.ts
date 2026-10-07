import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectFileSubscriptions } from "./projectFileSubscriptions";
const target = { peonId: "p", projectKey: "project", path: "src" };

test("deduplicates subscriptions, reconciles after reconnect and releases last listener", () => {
  const manager = new ProjectFileSubscriptions();
  const sent: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const a = manager.subscribe(target, (status) => statuses.push(status));
  const b = manager.subscribe(target, () => {});
  assert.equal(sent.length, 0);
  manager.connect((msg) => sent.push(msg as Record<string, unknown>), true);
  assert.equal(sent.length, 1);
  const watchId = sent[0].watchId;
  manager.handle({ type: "files:ready", watchId });
  manager.handle({ type: "files:changed", watchId });
  assert.deepEqual(statuses, ["ready", "changed"]);
  manager.connect(null);
  manager.connect((msg) => sent.push(msg as Record<string, unknown>), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].watchId, watchId);
  a(); assert.equal(sent.length, 2);
  b(); assert.equal(sent[2].type, "files:unsubscribe");
  manager.connect(null);
});

test("unsupported servers never receive subscriptions and nonretryable errors do not loop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = new ProjectFileSubscriptions();
  const sent: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  manager.connect((msg) => sent.push(msg as Record<string, unknown>), false);
  const stop = manager.subscribe(target, (status) => statuses.push(status));
  assert.deepEqual(statuses, ["unavailable"]); assert.equal(sent.length, 0);
  manager.connect((msg) => sent.push(msg as Record<string, unknown>), true);
  manager.handle({ type: "files:error", watchId: sent[0].watchId, retryable: false });
  t.mock.timers.tick(60_000); assert.equal(sent.length, 1);
  stop(); manager.connect(null);
});

test("failed upstream retries with backoff; hidden/unmounted trees cancel pending retries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = new ProjectFileSubscriptions();
  const sent: Array<Record<string, unknown>> = [];
  manager.connect((msg) => sent.push(msg as Record<string, unknown>), true);
  const stop = manager.subscribe(target, () => {});
  const error = () => manager.handle({ type: "files:error", watchId: sent[0].watchId, retryable: true });
  error(); t.mock.timers.tick(999); assert.equal(sent.length, 1);
  t.mock.timers.tick(1); assert.equal(sent.length, 2);
  error(); t.mock.timers.tick(1999); assert.equal(sent.length, 2);
  t.mock.timers.tick(1); assert.equal(sent.length, 3);
  error(); stop(); const count = sent.length;
  t.mock.timers.tick(60_000); assert.equal(sent.length, count);
  manager.connect(null);
});
