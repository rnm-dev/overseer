import assert from "node:assert/strict";
import test from "node:test";
import type { ApiRequest } from "../peonApi";
import {
  attachmentLabel,
  createQueueReconciler,
  enqueueSessionFollowup,
  getSessionQueue,
  removeSessionQueueItem,
  removeWaitingQueueItem,
  type QueueItem,
} from "./queue";

const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
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

test("queue API client preserves Fleet FIFO order and removes an encoded item", async () => {
  const first = item("1");
  const second = item("2");
  const fake = recorder({ items: [first, second] });
  assert.deepEqual(await getSessionQueue("/peon", "session/1", fake.request), [first, second]);
  await removeSessionQueueItem("/peon", "session/1", "item/2", fake.request);
  assert.deepEqual(fake.calls.map(({ path, options }) => [path, options?.method]), [
    ["/peon/sessions/session%2F1/queue", undefined],
    ["/peon/sessions/session%2F1/queue/item%2F2", "DELETE"],
  ]);
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
