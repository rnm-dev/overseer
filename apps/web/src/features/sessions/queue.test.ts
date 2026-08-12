import assert from "node:assert/strict";
import test from "node:test";
import type { ApiRequest } from "../fleet/peonApi";
import {
  attachmentLabel,
  createQueueActivityTracker,
  createQueueReconciler,
  enqueueSessionFollowup,
  getSessionQueue,
  mergeQueueRows,
  pruneSteeredQueueItems,
  removeSessionQueueItem,
  removeWaitingQueueItem,
  sendSessionQueueItemNow,
  sendWaitingQueueItemNow,
  steerSessionQueueItem,
  visibleQueueItems,
  type QueueItem,
} from "./queue";

const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  type: "queue",
  sessionId: "session/1",
  prompt: `prompt ${id}`,
  attachments: [],
  permissionMode: null,
  author: "viktor",
  model: null,
  reasoningEffort: null,
  commandId: null,
  queuedAt: Number(id.replace(/\D/g, "")) || 0,
  ...extra,
});

function recorder(response: unknown = {}) {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request: ApiRequest = async <T>(path: string, options?: RequestInit) => {
    calls.push({ path, options });
    return response as T;
  };
  return { calls, request };
}

test("queue API client preserves Fleet FIFO order and targets an encoded item for remove, steer, or deprecated send now", async () => {
  const first = item("1");
  const second = item("2");
  const fake = recorder({ items: [first, second] });
  assert.deepEqual(await getSessionQueue("/peon", "session/1", fake.request), [first, second]);
  await removeSessionQueueItem("/peon", "session/1", "item/2", fake.request);
  await steerSessionQueueItem("/peon", "session/1", "item/2", fake.request);
  await sendSessionQueueItemNow("/peon", "session/1", "item/2", fake.request);
  assert.deepEqual(fake.calls.map(({ path, options }) => [path, options?.method]), [
    ["/peon/sessions/session%2F1/queue", undefined],
    ["/peon/sessions/session%2F1/queue/item%2F2", "DELETE"],
    ["/peon/sessions/session%2F1/queue/item%2F2/steer", "POST"],
    ["/peon/sessions/session%2F1/queue/item%2F2/send", "POST"],
  ]);
});

test("authenticated concurrent queue readers share only within one operator scope", async () => {
  const resolvers: Array<(value: { items: QueueItem[] }) => void> = [];
  let calls = 0;
  const request: ApiRequest = async <T>() => {
    calls += 1;
    return new Promise<T>((resolve) => resolvers.push(resolve as (value: { items: QueueItem[] }) => void));
  };

  const first = getSessionQueue("/peon", "session-1", request, "operator-a");
  const strictModeReplay = getSessionQueue("/peon", "session-1", request, "operator-a");
  const otherOperator = getSessionQueue("/peon", "session-1", request, "operator-b");
  assert.equal(calls, 2);

  resolvers.shift()!({ items: [item("1")] });
  resolvers.shift()!({ items: [item("2")] });
  assert.deepEqual(await first, [item("1")]);
  assert.deepEqual(await strictModeReplay, [item("1")]);
  assert.deepEqual(await otherOperator, [item("2")]);
});

test("queued work keeps only its own session active across consecutive run results", () => {
  const activity = createQueueActivityTracker();
  activity.replace("peon-1:session-1", [item("1"), item("2")]);

  assert.equal(activity.hasPending("peon-1:session-1"), true);
  assert.equal(activity.hasPending("peon-1:session-2"), false);

  activity.replace("peon-1:session-1", [item("2")]);
  assert.equal(activity.hasPending("peon-1:session-1"), true);

  activity.replace("peon-1:session-1", []);
  assert.equal(activity.hasPending("peon-1:session-1"), false);
});

test("send now reconciles the authoritative queue and ignores an item already popped by Peon", async () => {
  let reconciled = 0;
  const failures: unknown[] = [];
  const accepted = await sendWaitingQueueItemNow(
    "already-popped",
    async () => { throw Object.assign(new Error("unknown queue item"), { code: "UNKNOWN_QUEUE_ITEM" }); },
    async () => { reconciled += 1; },
    (error) => failures.push(error),
  );
  assert.equal(reconciled, 1);
  assert.equal(accepted, false);
  assert.deepEqual(failures, []);
});

test("send now reports a real failure so optimistic activity can roll back", async () => {
  const error = Object.assign(new Error("offline"), { code: "PEON_UNREACHABLE" });
  const failures: unknown[] = [];
  const accepted = await sendWaitingQueueItemNow(
    "queued",
    async () => { throw error; },
    async () => {},
    (failure) => failures.push(failure),
  );
  assert.equal(accepted, false);
  assert.deepEqual(failures, [error]);
});

test("Queue & stop and ordinary queue preserve attachments, model, effort, and command ID", async () => {
  const fake = recorder();
  const payload = {
    prompt: "inspect these",
    attachments: [{ type: "image" as const, path: "uploads/session/image.png" }],
    permissionMode: "plan",
    model: "gpt-5.4",
    reasoningEffort: "medium",
    commandId: "command-1",
    startNow: true,
  };
  await enqueueSessionFollowup("/peon", "s", payload, fake.request);
  assert.equal(fake.calls[0]?.options?.method, "POST");
  assert.deepEqual(JSON.parse(String(fake.calls[0]?.options?.body)), payload);
});

test("SSE change reconciliation serializes GETs and applies the newest FIFO snapshot", async () => {
  const resolvers: Array<(items: QueueItem[]) => void> = [];
  const applied: string[][] = [];
  const reconciler = createQueueReconciler(
    () => new Promise<QueueItem[]>((resolve) => resolvers.push(resolve)),
    (items) => applied.push(items.map(({ id }) => id)),
  );
  const initial = reconciler.reconcile();
  void reconciler.reconcile(); // a stream `change` while initial GET is pending
  assert.equal(resolvers.length, 1);
  resolvers.shift()!([item("1"), item("2")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 1);
  resolvers.shift()!([item("2"), item("3")]);
  await initial;
  assert.deepEqual(applied, [["1", "2"], ["2", "3"]]);
});

test("UNKNOWN_QUEUE_ITEM after a pop is reconciled without surfacing an error", async () => {
  let reconciled = 0;
  const failures: unknown[] = [];
  await removeWaitingQueueItem(
    "already-popped",
    async () => { throw Object.assign(new Error("unknown queue item"), { code: "UNKNOWN_QUEUE_ITEM" }); },
    async () => { reconciled += 1; },
    (error) => failures.push(error),
  );
  assert.equal(reconciled, 1);
  assert.deepEqual(failures, []);
});

test("queued attachment labels retain names and fall back to path basenames", () => {
  assert.equal(attachmentLabel({ type: "file", name: "notes.md", path: "uploads/hash" }), "notes.md");
  assert.equal(attachmentLabel({ type: "image", path: "uploads/session/screenshot.png" }), "screenshot.png");
});

test("a departed queue item keeps its place to animate out, and a restored one is live again", () => {
  const first = item("1");
  const second = item("2");
  const third = item("3");
  const shown = mergeQueueRows([], [first, second, third]);
  assert.deepEqual(shown, [
    { item: first, leaving: false },
    { item: second, leaving: false },
    { item: third, leaving: false },
  ]);

  // The steered head leaves in place instead of the rows below it jumping up.
  const steered = mergeQueueRows(shown, [second, third]);
  assert.deepEqual(steered.map((row) => [row.item.id, row.leaving]), [["1", true], ["2", false], ["3", false]]);

  // A refused steer reconciles the item back: it is an ordinary row once more.
  const restored = mergeQueueRows(steered, [first, second, third]);
  assert.deepEqual(restored.map((row) => [row.item.id, row.leaving]), [["1", false], ["2", false], ["3", false]]);

  // Newly queued items append after everything already on screen.
  const fourth = item("4");
  assert.deepEqual(
    mergeQueueRows(restored, [first, second, third, fourth]).map((row) => row.item.id),
    ["1", "2", "3", "4"],
  );
});

test("a steered row stays hidden across the snapshots Peon answers before it pops", () => {
  const first = item("1");
  const second = item("2");
  const now = 1_000;
  // Steering is answered as soon as the redirect is issued; for a provider that
  // redirects by interrupting, the item is still queued for seconds afterwards.
  const steered = new Map([["1", now + 60_000]]);
  assert.deepEqual(visibleQueueItems([first, second], steered), [second]);

  const stillQueued = pruneSteeredQueueItems(steered, [first, second], now + 2_000);
  assert.deepEqual([...stillQueued.keys()], ["1"]);
  assert.deepEqual(visibleQueueItems([first, second], stillQueued), [second]);

  // Once the authoritative list agrees, nothing is left to hide.
  assert.equal(pruneSteeredQueueItems(stillQueued, [second], now + 3_000).size, 0);

  // A steer that never lands cannot hide a still-queued message forever.
  assert.equal(pruneSteeredQueueItems(steered, [first, second], now + 61_000).size, 0);
});

test("an unsteered queue list is passed through unchanged", () => {
  const items = [item("1"), item("2")];
  assert.equal(visibleQueueItems(items, new Map()), items);
});
