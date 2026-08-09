import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LivePreviewConsumer, type LivePreviewEvent, type LivePreviewKey } from "./livePreviewConsumer.js";

const key: LivePreviewKey = {
  workspaceId: "workspace",
  peonId: "peon",
  sessionId: "session",
  previewId: "preview",
};

function harness(now = 1_000) {
  const events: LivePreviewEvent[] = [];
  const watches: string[] = [];
  const consumer = new LivePreviewConsumer({
    now: () => now,
    authorize: async (_key, userId) => userId === "allowed",
    publish: (event) => { events.push(event); },
    watch: async ({ leaseId }) => { watches.push(`watch:${leaseId}`); },
    renew: async ({ leaseId }) => { watches.push(`renew:${leaseId}`); },
    unwatch: async ({ leaseId }) => { watches.push(`unwatch:${leaseId}`); },
  });
  return { consumer, events, watches };
}

function asset(path: string, bytes: Buffer, contentType = "text/html; charset=utf-8") {
  return {
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

test("consumer activates a complete revision atomically and serves immutable authorized bytes", async () => {
  const { consumer, events } = harness();
  await consumer.acquireViewer(key, "allowed");
  const html = Buffer.from("<h1>ready</h1>");
  assert.equal(consumer.begin(key, "generation-1", 1, [asset("index.html", html)]), html.length);
  assert.equal(consumer.snapshot(key)?.status, "uploading");
  consumer.pushChunk(key, "generation-1", 1, "index.html", html);
  assert.equal(await consumer.activate(key, "generation-1", 1, "index.html"), true);
  assert.equal(consumer.snapshot(key)?.status, "ready");

  const served = await consumer.readAuthorized(key, "allowed", 1, "index.html");
  assert.deepEqual(served.bytes, html);
  served.bytes.fill(0);
  assert.deepEqual((await consumer.readAuthorized(key, "allowed", 1, "index.html")).bytes, html);
  await assert.rejects(consumer.readAuthorized(key, "denied", 1, "index.html"), /PREVIEW_NOT_FOUND/);
  assert.deepEqual(events.map((event) => event.status), ["uploading", "ready"]);
});

test("incomplete, corrupt, stale and replaced-generation ingest never activates", async () => {
  const { consumer, events } = harness();
  await consumer.acquireViewer(key, "allowed");
  const html = Buffer.from("complete");
  consumer.begin(key, "generation-1", 1, [asset("index.html", html)]);
  consumer.pushChunk(key, "generation-1", 1, "index.html", html.subarray(0, 2));
  await assert.rejects(consumer.activate(key, "generation-1", 1, "index.html"), /INCOMPLETE/);
  assert.equal(consumer.snapshot(key)?.status, "uploading");

  await consumer.cancelGeneration("peon", "generation-1");
  assert.equal(consumer.snapshot(key)?.status, "error");
  assert.throws(() => consumer.pushChunk(key, "generation-1", 1, "index.html", html), /STALE_PREVIEW_INGEST/);
  assert.throws(() => consumer.begin(key, "generation-2", 1, [asset("index.html", html)]), /STALE_PREVIEW_REVISION/);

  consumer.begin(key, "generation-2", 2, [asset("index.html", html)]);
  consumer.pushChunk(key, "generation-2", 2, "index.html", Buffer.from("corrupt!"));
  await assert.rejects(consumer.activate(key, "generation-2", 2, "index.html"), /CHECKSUM/);
  assert.equal(consumer.snapshot(key)?.status, "error");
  assert.throws(() => consumer.pushChunk(key, "generation-2", 2, "index.html", html), /STALE_PREVIEW_INGEST/);
  assert.equal(events.some((event) => event.code === "TRANSFER_REPLACED"), true);
});

test("multi-asset manifest requires every declared asset and its entry", async () => {
  const { consumer } = harness();
  await consumer.acquireViewer(key, "allowed");
  const html = Buffer.from("<link rel=stylesheet href=app.css>");
  const css = Buffer.from("body{}");
  consumer.begin(key, "generation", 1, [
    asset("index.html", html),
    asset("app.css", css, "text/css; charset=utf-8"),
  ]);
  consumer.pushChunk(key, "generation", 1, "index.html", html);
  await assert.rejects(consumer.activate(key, "generation", 1, "index.html"), /INCOMPLETE/);
  consumer.pushChunk(key, "generation", 1, "app.css", css);
  await assert.rejects(consumer.activate(key, "generation", 1, "missing.html"), /entry missing/);
  assert.equal(await consumer.activate(key, "generation", 1, "index.html"), true);
});

test("viewer leases are shared, renewed, released and expired without leaking content", async () => {
  let now = 1_000;
  const events: LivePreviewEvent[] = [];
  const calls: string[] = [];
  const consumer = new LivePreviewConsumer({
    now: () => now,
    authorize: async () => true,
    publish: (event) => { events.push(event); },
    watch: async ({ leaseId }) => { calls.push(`watch:${leaseId}`); },
    renew: async ({ leaseId }) => { calls.push(`renew:${leaseId}`); },
    unwatch: async ({ leaseId }) => { calls.push(`unwatch:${leaseId}`); },
  });
  const first = await consumer.acquireViewer(key, "one");
  const second = await consumer.acquireViewer(key, "two");
  assert.equal(calls.filter((call) => call.startsWith("watch:")).length, 1);
  await consumer.renewViewer(key, first.leaseId, "one");
  await consumer.releaseViewer(key, first.leaseId, "one");
  assert.notEqual(consumer.snapshot(key), null);

  now = second.expiresAt + 1;
  await consumer.reconcile();
  assert.equal(consumer.snapshot(key), null);
  assert.equal(events.at(-1)?.status, "expired");
  assert.equal(calls.filter((call) => call.startsWith("unwatch:")).length, 1);
});

test("deletion removes prior content and stale deletion cannot replace a newer revision", async () => {
  const { consumer } = harness();
  await consumer.acquireViewer(key, "allowed");
  const bytes = Buffer.from("ready");
  consumer.begin(key, "generation", 2, [asset("index.html", bytes)]);
  consumer.pushChunk(key, "generation", 2, "index.html", bytes);
  await consumer.activate(key, "generation", 2, "index.html");
  await consumer.deleted(key, "generation", 1);
  assert.equal(consumer.snapshot(key)?.status, "ready");
  await consumer.deleted(key, "generation", 3);
  assert.equal(consumer.snapshot(key)?.status, "deleted");
  await assert.rejects(consumer.readAuthorized(key, "allowed", 2, "index.html"), /PREVIEW_NOT_FOUND/);
});
