import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import { ProjectCatalog } from "../projects/index.js";
import { ProjectCatalogChannel } from "../overseer/socket/channels/projectCatalogChannel.js";
import { ProjectStore } from "../projects/contracts.js";
import { PeonSocketOutbox } from "../overseer/socket/peonSocketOutbox.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-channel-"));
  const store = new ProjectStore(path.join(root, "projects.json"));
  const catalog = new ProjectCatalog(store);
  return { root, store, catalog, channel: new ProjectCatalogChannel(catalog) };
}

function capture(durable = true) {
  const frames: PeonSocketFrame[] = [];
  const durableFrames: Array<{ frame: PeonSocketFrame; options: unknown }> = [];
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable,
    send: (frame) => { frames.push(frame); return true; },
    sendBinary: () => true,
    sendDurable: (frame, options) => {
      durableFrames.push({ frame, options });
      return durable
        ? { accepted: true, epoch: "delivery", cursor: `cursor-${durableFrames.length}`, messageId: `message-${durableFrames.length}` }
        : { accepted: false, code: "PERSIST_FAILED", error: "disabled" };
    },
    disconnect: (reason) => disconnects.push(reason),
  };
  return { frames, durableFrames, disconnects, sender };
}

test("capability requires durable delivery and is inactive when unaccepted", () => {
  const inactive = fixture();
  const output = capture(true);
  inactive.channel.negotiated(false, {}, output.sender);
  inactive.store.createProject({ key: "ignored", label: "Ignored", dir: path.join(inactive.root, "ignored") });
  assert.deepEqual(output.durableFrames, []);

  const required = fixture();
  const nonDurable = capture(false);
  required.channel.negotiated(true, {}, nonDurable.sender);
  assert.deepEqual(nonDurable.disconnects, ["project catalog requires durable-delivery-v1"]);
});

test("resume replays exact persisted events and project ack is independent", () => {
  const { root, store, catalog, channel } = fixture();
  const created = store.createProject({ key: "alpha", label: "Alpha", dir: path.join(root, "alpha") });
  store.update("alpha", { key: "beta" });
  const output = capture();
  channel.negotiated(true, {
    channels: { "project-catalog-v1": { epoch: catalog.state().epoch, acknowledgedSeq: 0 } },
  }, output.sender);

  assert.deepEqual(output.durableFrames.map(({ frame }) => frame.seq), [1, 2]);
  assert.equal((output.durableFrames[1]?.frame.project as PeonSocketFrame).projectId, created.projectId);
  assert.equal((output.durableFrames[1]?.frame.project as PeonSocketFrame).key, "beta");
  assert.deepEqual(output.durableFrames.map(({ options }) => (options as PeonSocketFrame).capability), [
    "project-catalog-v1",
    "project-catalog-v1",
  ]);

  channel.receive({ type: "project_catalog_ack", epoch: catalog.state().epoch, acknowledgedSeq: 1 }, output.sender);
  assert.deepEqual(catalog.eventsAfter(1)?.map((event) => event.seq), [2]);
  channel.receive({ type: "project_catalog_ack", epoch: "wrong", acknowledgedSeq: 2 }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_CURSOR");
});

test("snapshot and live events use separate frames with no unsafe rollups", () => {
  const { root, store, catalog, channel } = fixture();
  store.createProject({ key: "alpha", label: "Alpha", dir: path.join(root, "alpha") });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  channel.receive({ type: "project_catalog_snapshot_request", requestId: "sync", limit: 10 }, output.sender);
  const page = output.frames.at(-1)!;
  assert.equal(page.type, "project_catalog_snapshot_page");
  const project = (page.projects as PeonSocketFrame[])[0]!;
  assert.deepEqual(Object.keys(project).sort(), ["archivedAt", "dir", "key", "label", "projectId", "quickLinks"]);

  store.update("alpha", { label: "Updated" });
  assert.equal(output.durableFrames.at(-1)?.frame.type, "project_catalog_event");
  assert.equal("sessionCount" in (output.durableFrames.at(-1)?.frame.project as PeonSocketFrame), false);
  store.update("alpha", { archivedAt: Date.now() });
  assert.equal(typeof (output.durableFrames.at(-1)?.frame.project as PeonSocketFrame).archivedAt, "number");
});

test("durable production continues offline but resets when socket authority changes", () => {
  const { root, store, channel } = fixture();
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  channel.disconnected(false);
  store.createProject({ key: "offline", label: "Offline", dir: path.join(root, "offline") });
  assert.equal(output.durableFrames.length, 1);
  channel.disconnected(true);
  store.update("offline", { label: "Not produced" });
  assert.equal(output.durableFrames.length, 1);
});

test("project events preserve shared durable order with interleaved channel messages", () => {
  const { root, store, channel } = fixture();
  const outbox = new PeonSocketOutbox({ fileBase: path.join(root, "outbox") });
  const sender: PeonSocketSender = {
    durable: true,
    send: () => true,
    sendBinary: () => true,
    sendDurable: (frame, options) => outbox.enqueue(frame, options),
    disconnect: () => {},
  };
  channel.negotiated(true, {}, sender);
  store.createProject({ key: "first", label: "First", dir: path.join(root, "first") });
  outbox.enqueue({ type: "configuration_event", revision: 7 }, {
    capability: "configuration-v1",
    dedupeKey: "configuration:7",
  });
  store.createProject({ key: "second", label: "Second", dir: path.join(root, "second") });

  assert.deepEqual(outbox.pending().map((message) => message.payload.type), [
    "project_catalog_event",
    "configuration_event",
    "project_catalog_event",
  ]);
});

test("a lost project acknowledgement is retried independently of durable delivery", async () => {
  const { root, store, catalog } = fixture();
  const channel = new ProjectCatalogChannel(catalog, 10);
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  store.createProject({ key: "retry", label: "Retry", dir: path.join(root, "retry") });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(output.durableFrames.length >= 2);
  assert.deepEqual(new Set(output.durableFrames.map(({ frame }) => frame.seq)), new Set([1]));

  channel.receive({
    type: "project_catalog_ack",
    epoch: catalog.state().epoch,
    acknowledgedSeq: 1,
  }, output.sender);
  const afterAck = output.durableFrames.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(output.durableFrames.length, afterAck);
  channel.disconnected(true);
});

test("a lost acknowledgement after a fresh snapshot retries retained events", async () => {
  const { root, store, catalog } = fixture();
  store.createProject({ key: "snapshot", label: "Snapshot", dir: path.join(root, "snapshot") });
  const channel = new ProjectCatalogChannel(catalog, 10);
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "project_catalog_snapshot_request",
    requestId: "fresh",
    limit: 10,
  }, output.sender);
  assert.equal(output.frames.at(-1)?.hasMore, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(output.durableFrames.some(({ frame }) => frame.type === "project_catalog_event" && frame.seq === 1));
  channel.disconnected(true);
});

test("malformed and unnegotiated frames fail without mutating catalog state", () => {
  const { channel } = fixture();
  const output = capture();
  channel.receive({ type: "project_catalog_snapshot_request", requestId: "sync" }, output.sender);
  assert.deepEqual(output.disconnects, ["unnegotiated project catalog frame"]);
  channel.negotiated(true, {}, output.sender);
  channel.receive({ type: "project_catalog_snapshot_request", requestId: "", limit: 1 }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_REQUEST");
  channel.receive({ type: "project_catalog_snapshot_request", requestId: "sync", cursor: 123 }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_CURSOR");
});
