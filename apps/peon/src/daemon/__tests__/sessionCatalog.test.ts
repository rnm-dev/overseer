import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  MAX_SESSION_CATALOG_EVENTS,
  SESSION_CATALOG_SNAPSHOT_TTL_MS,
  SessionCatalog,
  SessionCatalogError,
} from "../sessions/sessionCatalog.js";
import type { SessionRecord } from "../sessions/index.js";

function record(id: string, lastActivityAt: number): SessionRecord {
  return {
    id,
    status: "completed",
    projectKey: null,
    projectId: null,
    title: null,
    prompt: `prompt ${id}`,
    lastMessagePreview: null,
    initiator: null,
    outcome: null,
    startedAt: lastActivityAt,
    endedAt: lastActivityAt,
    lastActivityAt,
  } as SessionRecord;
}

class Source extends EventEmitter {
  records: SessionRecord[];
  constructor(records: SessionRecord[]) {
    super();
    this.records = records;
  }
  list(): SessionRecord[] { return this.records; }
  change(next: SessionRecord): void {
    this.records = this.records.map((item) => item.id === next.id ? next : item);
    this.emit("change", next);
  }
  remove(id: string): void {
    this.records = this.records.filter((item) => item.id !== id);
    this.emit("delete", id);
  }
}

test("snapshot pages are frozen and concurrent changes replay after the barrier", () => {
  const source = new Source([record("a", 1), record("b", 2)]);
  const catalog = new SessionCatalog(source);
  catalog.start();

  const first = catalog.page("request-1", 1);
  source.change(record("b", 3));
  source.remove("a");
  const second = catalog.page("request-1", 1, first.nextCursor!);

  assert.deepEqual(first.sessions.map((item) => item.id), ["a"]);
  assert.deepEqual(second.sessions.map((item) => item.id), ["b"]);
  assert.equal(first.barrierSeq, 0);
  assert.equal(second.barrierSeq, first.barrierSeq);
  assert.deepEqual(catalog.eventsAfter(first.barrierSeq)?.map((event) => event.seq), [1, 2]);
  assert.ok("session" in catalog.eventsAfter(0)![0]);
  assert.deepEqual(catalog.eventsAfter(0)![1], { seq: 2, revision: 2, deletedSessionId: "a" });
});

test("catalog bounds replay history and rejects an unavailable cursor", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  catalog.start();
  for (let index = 0; index <= MAX_SESSION_CATALOG_EVENTS; index += 1) {
    source.change(record("a", index));
  }
  assert.equal(catalog.eventsAfter(0), null);
  assert.equal(catalog.eventsAfter(catalog.state().earliestSeq - 1)?.length, MAX_SESSION_CATALOG_EVENTS);
});

test("acknowledgements prune committed replay history and reject future cursors", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  catalog.start();
  source.change(record("a", 2));
  source.change(record("a", 3));
  assert.equal(catalog.acknowledge(1), true);
  assert.deepEqual(catalog.eventsAfter(1)?.map((event) => event.seq), [2]);
  assert.equal(catalog.eventsAfter(0), null);
  assert.equal(catalog.acknowledge(3), false);
});

test("only one snapshot is active and cancellation releases it", () => {
  const source = new Source([record("a", 1)]);
  const catalog = new SessionCatalog(source);
  catalog.page("first", 1);
  assert.throws(
    () => catalog.page("second", 1),
    (error: unknown) => error instanceof SessionCatalogError && error.code === "SYNC_IN_PROGRESS",
  );
  catalog.cancel("first");
  assert.equal(catalog.page("second", 1).requestId, "second");
});

test("large requested pages are byte-bounded as well as count-bounded", () => {
  const records = Array.from({ length: 200 }, (_, index) => {
    const next = record(`session-${index}`, index);
    next.prompt = "x".repeat(2_000);
    next.lastMessagePreview = "y".repeat(2_000);
    return next;
  });
  const catalog = new SessionCatalog(new Source(records));
  const page = catalog.page("bounded", 200);
  assert.ok(page.sessions.length < 200);
  assert.ok(Buffer.byteLength(JSON.stringify(page.sessions)) < 55 * 1024);
  assert.equal(page.hasMore, true);
});

test("expired snapshots reject their old opaque cursor", () => {
  let now = 1_000;
  const catalog = new SessionCatalog(new Source([record("a", 1), record("b", 2)]), () => now);
  const first = catalog.page("expiring", 1);
  now += SESSION_CATALOG_SNAPSHOT_TTL_MS;
  assert.throws(
    () => catalog.page("expiring", 1, first.nextCursor!),
    (error: unknown) => error instanceof SessionCatalogError && error.code === "BAD_CURSOR",
  );
});
