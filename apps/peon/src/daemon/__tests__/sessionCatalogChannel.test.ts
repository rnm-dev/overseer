import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import { SessionCatalog } from "../sessionCatalog.js";
import { SessionCatalogChannel } from "../overseer/socket/channels/sessionCatalogChannel.js";
import type { SessionRecord } from "../sessions/index.js";

function record(id: string, activity: number): SessionRecord {
  return {
    id,
    status: "completed",
    projectKey: null,
    projectId: null,
    title: null,
    prompt: id,
    lastMessagePreview: null,
    initiator: null,
    outcome: null,
    startedAt: activity,
    endedAt: activity,
    lastActivityAt: activity,
  } as SessionRecord;
}

class Source extends EventEmitter {
  constructor(public records: SessionRecord[]) { super(); }
  list(): SessionRecord[] { return this.records; }
  change(next: SessionRecord): void {
    this.records = this.records.map((item) => item.id === next.id ? next : item);
    this.emit("change", next);
  }
}

function capture(durable = false) {
  const frames: PeonSocketFrame[] = [];
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable,
    send: (frame) => { frames.push(frame); return true; },
    sendBinary: () => true,
    sendDurable: (frame) => {
      if (!durable) return { accepted: false, code: "PERSIST_FAILED", error: "disabled" };
      frames.push(frame);
      return { accepted: true, epoch: "delivery", cursor: "cursor", messageId: "message" };
    },
    disconnect: (reason) => disconnects.push(reason),
  };
  return { frames, disconnects, sender };
}

test("negotiated durable channel prunes acknowledged history and streams changes", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  catalog.start();
  source.change(record("a", 2));
  const channel = new SessionCatalogChannel(catalog);
  const output = capture(true);

  channel.negotiated(true, {
    channels: { "session-catalog-v1": { epoch: catalog.epoch, acknowledgedSeq: 0 } },
  }, output.sender);
  source.change(record("a", 3));

  assert.deepEqual(output.frames.map((frame) => frame.type), ["session_catalog_event", "session_catalog_event"]);
  assert.deepEqual(output.frames.map((frame) => frame.seq), [1, 2]);
});

test("snapshot frames are correlated, fenced, paginated, and cancellable", () => {
  const source = new Source([record("a", 1), record("b", 2)]);
  const catalog = new SessionCatalog(source);
  const channel = new SessionCatalogChannel(catalog);
  const output = capture(true);
  channel.negotiated(true, {}, output.sender);

  channel.receive({ type: "session_catalog_snapshot_request", requestId: "sync-1", limit: 1 }, output.sender);
  const first = output.frames.at(-1)!;
  assert.equal(first.type, "session_catalog_snapshot_page");
  assert.equal(first.requestId, "sync-1");
  assert.equal(first.barrierSeq, 0);
  assert.equal((first.sessions as unknown[]).length, 1);
  assert.equal(typeof first.nextCursor, "string");

  source.change(record("a", 4));
  channel.receive({ type: "session_catalog_snapshot_request", requestId: "sync-1", limit: 1, cursor: first.nextCursor }, output.sender);
  const second = output.frames.at(-1)!;
  assert.equal(second.type, "session_catalog_snapshot_page");
  assert.equal(second.barrierSeq, 0);
  assert.equal(second.hasMore, false);

  channel.receive({ type: "session_catalog_snapshot_cancel", requestId: "sync-1" }, output.sender);
  assert.equal(output.frames.at(-1)?.type, "session_catalog_snapshot_cancelled");
  assert.deepEqual(output.disconnects, []);
});

test("missing negotiation leaves session synchronization inactive", () => {
  const source = new Source([]);
  const channel = new SessionCatalogChannel(new SessionCatalog(source));
  const output = capture(true);
  channel.negotiated(false, {}, output.sender);
  source.change(record("a", 1));
  assert.deepEqual(output.frames, []);
  assert.deepEqual(output.disconnects, []);
});

test("session catalog capability requires durable delivery", () => {
  const channel = new SessionCatalogChannel(new SessionCatalog(new Source([])));
  const output = capture(false);
  channel.negotiated(true, {}, output.sender);
  assert.deepEqual(output.disconnects, ["session catalog requires durable-delivery-v1"]);
});

test("acknowledgements prune the journal and reject the wrong epoch", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  const channel = new SessionCatalogChannel(catalog);
  const output = capture(true);
  channel.negotiated(true, {}, output.sender);
  source.change(record("a", 2));
  output.frames.length = 0;

  channel.receive({ type: "session_catalog_ack", epoch: catalog.epoch, acknowledgedSeq: 1 }, output.sender);
  assert.deepEqual(catalog.eventsAfter(1), []);
  channel.receive({ type: "session_catalog_ack", epoch: "wrong", acknowledgedSeq: 1 }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_CURSOR");
});

test("output backpressure disconnects so reconnect can resume safely", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  const disconnects: string[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    send: () => false,
    sendBinary: () => false,
    sendDurable: () => ({ accepted: false, code: "OUTBOX_FULL", error: "full" }),
    disconnect: (reason) => disconnects.push(reason),
  };
  const channel = new SessionCatalogChannel(catalog);
  channel.negotiated(true, {}, sender);
  source.change(record("a", 2));
  assert.deepEqual(disconnects, ["session catalog backpressure limit exceeded"]);
});

test("durable catalog production continues across a transient socket disconnect", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  const durableFrames: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: true,
    send: () => false,
    sendBinary: () => false,
    sendDurable: (frame) => {
      durableFrames.push(frame);
      return { accepted: true, epoch: "outbox", cursor: "cursor", messageId: "message" };
    },
    disconnect: () => {},
  };
  const channel = new SessionCatalogChannel(catalog);
  channel.negotiated(true, {}, sender);
  channel.disconnected(false);
  source.change(record("a", 2));
  assert.equal(durableFrames.length, 1);
  assert.equal(durableFrames[0]?.type, "session_catalog_event");

  channel.disconnected(true);
  source.change(record("a", 3));
  assert.equal(durableFrames.length, 1);
});
