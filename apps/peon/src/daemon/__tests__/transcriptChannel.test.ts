import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AgentEvent } from "../agents/index.js";
import type { PeonSocketDurableOptions, PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";
import {
  MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS,
  MAX_TRANSCRIPT_OUTSTANDING_PER_SESSION,
  TRANSCRIPT_SNAPSHOT_TTL_MS,
  TranscriptChannel,
} from "../overseer/socket/channels/transcriptChannel.js";
import {
  MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES,
  TranscriptPublicationRepository,
  publishedTranscriptEvent,
  transcriptDurableEnvelopeBytes,
} from "../transcriptPublication.js";
import type { SessionRecord, TranscriptEntry } from "../sessions/index.js";

function session(id: string, startedAt = 100): SessionRecord {
  return { id, startedAt, agent: "claude-code" } as SessionRecord;
}

function entry(id: string, type: AgentEvent["type"] = "assistant", extra: Record<string, unknown> = {}): TranscriptEntry {
  return {
    id,
    event: {
      type,
      createdAt: Number(id.replace(/\D/g, "")) || 1,
      ...extra,
    },
  };
}

class Source extends EventEmitter {
  readonly records = new Map<string, SessionRecord>();
  constructor(ids: string[]) {
    super();
    for (const id of ids) this.records.set(id, session(id));
  }
  get(id: string): SessionRecord | undefined { return this.records.get(id); }
  remove(id: string): void {
    this.records.delete(id);
    this.emit("delete", id);
  }
}

function repositoryFixture(
  ids: string[],
  persisted: Record<string, TranscriptEntry[]>,
) {
  const source = new Source(ids);
  let commit: ((payload: { sessionId: string; entry: TranscriptEntry }) => void) | null = null;
  const repository = new TranscriptPublicationRepository({
    source,
    readCommitted: (sessionId) => (persisted[sessionId] ?? []).map((item) => structuredClone(item)),
    flush: async () => {},
    subscribeCommits: (listener) => {
      commit = listener;
      return () => { commit = null; };
    },
  });
  const append = (sessionId: string, next: TranscriptEntry) => {
    persisted[sessionId] ??= [];
    persisted[sessionId].push(structuredClone(next));
    commit?.({ sessionId, entry: next });
  };
  return { source, repository, append };
}

function capture(durable = true) {
  const frames: PeonSocketFrame[] = [];
  const durableFrames: Array<{ frame: PeonSocketFrame; options?: PeonSocketDurableOptions; cursor: string }> = [];
  const disconnects: string[] = [];
  let cursor = 0;
  let durableFailure: "OUTBOX_FULL" | "PERSIST_FAILED" | null = null;
  const dedupe = new Map<string, string>();
  const sender: PeonSocketSender = {
    durable,
    send: (frame) => { frames.push(structuredClone(frame)); return true; },
    sendBinary: () => true,
    sendDurable: (frame, options) => {
      if (!durable) return { accepted: false, code: "PERSIST_FAILED", error: "disabled" };
      if (durableFailure) return { accepted: false, code: durableFailure, error: durableFailure.toLowerCase() };
      const existing = options?.dedupeKey ? dedupe.get(options.dedupeKey) : undefined;
      const acceptedCursor = existing ?? `cursor-${++cursor}`;
      if (!existing) {
        if (options?.dedupeKey) dedupe.set(options.dedupeKey, acceptedCursor);
        durableFrames.push({ frame: structuredClone(frame), options: structuredClone(options), cursor: acceptedCursor });
      }
      return { accepted: true, epoch: "delivery", cursor: acceptedCursor, messageId: `message-${acceptedCursor}` };
    },
    disconnect: (reason) => disconnects.push(reason),
  };
  return {
    frames,
    durableFrames,
    disconnects,
    sender,
    failDurable: (code: "OUTBOX_FULL" | "PERSIST_FAILED" | null) => { durableFailure = code; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function snapshot(
  channel: TranscriptChannel,
  sender: PeonSocketSender,
  requestId: string,
  sessionId: string,
  subscribe = true,
  limit = 100,
): Promise<void> {
  channel.receive({
    type: "transcript_snapshot_request",
    requestId,
    sessionId,
    subscribe,
    limit,
  }, sender);
  await settle();
}

test("snapshot barrier plus committed live publication has no gap or duplicate", async () => {
  const fixture = repositoryFixture(["s1"], { s1: [entry("e1")] });
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  await snapshot(channel, output.sender, "snapshot-1", "s1");
  const page = output.frames.find((frame) => frame.type === "transcript_snapshot_page")!;
  assert.equal(page.epoch, (page.events as PeonSocketFrame[])[0]?.epoch);
  assert.equal(page.barrierSeq, 1);
  assert.deepEqual((page.events as PeonSocketFrame[]).map((event) => event.seq), [1]);

  fixture.append("s1", entry("e2"));
  fixture.append("s1", entry("e2"));
  assert.deepEqual(output.durableFrames.map(({ frame }) => frame.seq), [2]);
  assert.equal(output.durableFrames[0]?.frame.eventId, "e2");
  assert.deepEqual(output.disconnects, []);
  channel.disconnected(true);
});

test("stable epoch and sequence recover across repository restart and torn rows stay outside canonical truth", async () => {
  const persisted = { s1: [entry("e1"), entry("e2")] };
  const first = repositoryFixture(["s1"], persisted);
  const before = await first.repository.state("s1");
  first.repository.stop();

  const restarted = repositoryFixture(["s1"], persisted);
  const after = await restarted.repository.state("s1");
  assert.equal(after.epoch, before.epoch);
  assert.deepEqual(after.entries.map((event) => [event.seq, event.eventId]), [[1, "e1"], [2, "e2"]]);
  restarted.append("s1", entry("e3", "result", { usage: { input_tokens: 7 } }));
  assert.equal((await restarted.repository.state("s1")).entries.at(-1)?.seq, 3);
  restarted.repository.stop();
});

test("resume catch-up dedupes durable replay and duplicate acknowledgement is harmless", async () => {
  const fixture = repositoryFixture(["s1"], { s1: [entry("e1"), entry("e2")] });
  const state = await fixture.repository.state("s1");
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "transcript_subscribe",
    requestId: "resume-1",
    sessionId: "s1",
    epoch: state.epoch,
    afterSeq: 1,
  }, output.sender);
  await settle();
  assert.deepEqual(output.durableFrames.map(({ frame }) => frame.seq), [2]);
  const cursor = output.durableFrames[0]!.cursor;
  channel.durableAcknowledged(cursor);
  channel.durableAcknowledged(cursor);

  channel.disconnected(false);
  channel.negotiated(true, {}, output.sender);
  fixture.append("s1", entry("e3", "result"));
  assert.deepEqual(output.durableFrames.map(({ frame }) => frame.seq), [2, 3]);
  assert.equal(output.durableFrames[1]?.options?.priority, "critical");
  channel.disconnected(true);
});

test("noisy-session backlog is fenced without starving another subscribed session", async () => {
  const fixture = repositoryFixture(["noisy", "quiet"], { noisy: [], quiet: [] });
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  await snapshot(channel, output.sender, "snap-noisy", "noisy");
  await snapshot(channel, output.sender, "snap-quiet", "quiet");

  for (let index = 1; index <= MAX_TRANSCRIPT_OUTSTANDING_PER_SESSION + 1; index += 1) {
    fixture.append("noisy", entry(`n${index}`));
  }
  fixture.append("quiet", entry("q1", "result"));

  assert.equal(output.durableFrames.filter(({ frame }) => frame.sessionId === "noisy").length, MAX_TRANSCRIPT_OUTSTANDING_PER_SESSION);
  assert.equal(output.frames.some((frame) => frame.type === "transcript_error"
    && frame.sessionId === "noisy" && frame.code === "RESYNC_REQUIRED"), true);
  assert.equal(output.durableFrames.some(({ frame }) => frame.sessionId === "quiet" && frame.seq === 1), true);
  channel.disconnected(true);
});

test("active snapshot, cursor ownership, request shape, and session ownership are bounded", async () => {
  const ids = Array.from({ length: MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS + 1 }, (_, index) => `s${index}`);
  const persisted = Object.fromEntries(ids.map((id) => [id, [entry(`${id}e1`), entry(`${id}e2`)]]));
  const fixture = repositoryFixture(ids, persisted);
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  channel.receive({ type: "transcript_snapshot_request", requestId: "", sessionId: "s0" }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_REQUEST");
  channel.receive({ type: "transcript_snapshot_request", requestId: "missing", sessionId: "unknown" }, output.sender);
  await settle();
  assert.equal(output.frames.at(-1)?.code, "UNKNOWN_SESSION");

  for (let index = 0; index < MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS; index += 1) {
    await snapshot(channel, output.sender, `snap-${index}`, `s${index}`, false, 1);
  }
  const first = output.frames.find((frame) => frame.type === "transcript_snapshot_page" && frame.requestId === "snap-0")!;
  assert.equal(typeof first.nextCursor, "string");
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "snap-0",
    sessionId: "s1",
    cursor: first.nextCursor,
  }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "BAD_CURSOR");
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "too-many",
    sessionId: ids.at(-1),
  }, output.sender);
  await settle();
  assert.equal(output.frames.at(-1)?.code, "SNAPSHOT_LIMIT");

  channel.disconnected(false);
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "snap-0",
    sessionId: "s0",
    cursor: first.nextCursor,
  }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "CURSOR_UNAVAILABLE");
  channel.disconnected(true);
});

test("expired continuation cannot revive an already materialized snapshot without the maintenance timer", async () => {
  const fixture = repositoryFixture(["s1"], { s1: [entry("e1"), entry("e2")] });
  let now = 1_000;
  const channel = new TranscriptChannel({ repository: fixture.repository, now: () => now });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  await snapshot(channel, output.sender, "lease-materialized", "s1", false, 1);
  const firstPage = output.frames.find((frame) => frame.type === "transcript_snapshot_page")!;
  assert.equal(typeof firstPage.nextCursor, "string");

  now += TRANSCRIPT_SNAPSHOT_TTL_MS;
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "lease-materialized",
    sessionId: "s1",
    cursor: firstPage.nextCursor,
  }, output.sender);

  assert.equal(output.frames.filter((frame) => frame.type === "transcript_snapshot_page").length, 1);
  assert.equal(output.frames.at(-1)?.code, "CURSOR_UNAVAILABLE");
  channel.disconnected(true);
});

test("concurrent in-flight snapshots reserve the active limit before repository reads finish", async () => {
  const ids = Array.from({ length: MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS + 3 }, (_, index) => `pending-${index}`);
  const source = new Source(ids);
  const gate = deferred<void>();
  let reads = 0;
  const repository = new TranscriptPublicationRepository({
    source,
    flush: async () => {},
    readCommitted: async (sessionId) => {
      reads += 1;
      await gate.promise;
      return [entry(`${sessionId}-event`)];
    },
    subscribeCommits: () => () => {},
  });
  const channel = new TranscriptChannel({ repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  for (const [index, sessionId] of ids.entries()) {
    channel.receive({
      type: "transcript_snapshot_request",
      requestId: `pending-request-${index}`,
      sessionId,
      subscribe: false,
    }, output.sender);
  }
  await settle();
  assert.equal(reads, MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS);
  assert.equal(output.frames.filter((frame) => frame.type === "transcript_error" && frame.code === "SNAPSHOT_LIMIT").length, 3);

  gate.resolve(undefined);
  await settle();
  assert.equal(output.frames.filter((frame) => frame.type === "transcript_snapshot_page").length, MAX_ACTIVE_TRANSCRIPT_SNAPSHOTS);
  channel.disconnected(true);
});

test("deferred snapshot load resolving at lease expiry emits no page before maintenance runs", async () => {
  const source = new Source(["s1"]);
  const gate = deferred<void>();
  let now = 5_000;
  const repository = new TranscriptPublicationRepository({
    source,
    flush: async () => {},
    readCommitted: async () => {
      await gate.promise;
      return [entry("event-1")];
    },
    subscribeCommits: () => () => {},
  });
  const channel = new TranscriptChannel({ repository, now: () => now });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "lease-pending",
    sessionId: "s1",
    subscribe: true,
  }, output.sender);
  await settle();

  now += TRANSCRIPT_SNAPSHOT_TTL_MS;
  gate.resolve(undefined);
  await settle();

  assert.equal(output.frames.some((frame) => frame.type === "transcript_snapshot_page"), false);
  assert.equal(output.frames.at(-1)?.code, "CURSOR_UNAVAILABLE");
  assert.equal(output.durableFrames.length, 0);
  channel.disconnected(true);
});

test("snapshot cancellation fences an in-flight load and permits safe request-id reuse", async () => {
  const source = new Source(["s1"]);
  const firstRead = deferred<void>();
  let reads = 0;
  const repository = new TranscriptPublicationRepository({
    source,
    flush: async () => {},
    readCommitted: async () => {
      reads += 1;
      if (reads === 1) await firstRead.promise;
      return [entry(`event-${reads}`)];
    },
    subscribeCommits: () => () => {},
  });
  const channel = new TranscriptChannel({ repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);

  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "reused-request",
    sessionId: "s1",
    subscribe: true,
  }, output.sender);
  await settle();
  channel.receive({ type: "transcript_snapshot_cancel", requestId: "reused-request" }, output.sender);
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "reused-request",
    sessionId: "s1",
    subscribe: false,
  }, output.sender);
  await settle();
  assert.equal(output.frames.filter((frame) => frame.type === "transcript_snapshot_page").length, 1);

  firstRead.resolve(undefined);
  await settle();
  assert.equal(output.frames.filter((frame) => frame.type === "transcript_snapshot_page").length, 1);
  assert.equal(output.frames.some((frame) => frame.type === "transcript_snapshot_cancelled"), true);
  channel.disconnected(true);
});

test("socket generation fences completion of an in-flight snapshot load", async () => {
  const source = new Source(["s1"]);
  const gate = deferred<void>();
  const repository = new TranscriptPublicationRepository({
    source,
    flush: async () => {},
    readCommitted: async () => {
      await gate.promise;
      return [entry("event-1")];
    },
    subscribeCommits: () => () => {},
  });
  const channel = new TranscriptChannel({ repository });
  const oldOutput = capture();
  const nextOutput = capture();
  channel.negotiated(true, {}, oldOutput.sender);
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "old-generation",
    sessionId: "s1",
  }, oldOutput.sender);
  await settle();

  channel.disconnected(false);
  channel.negotiated(true, {}, nextOutput.sender);
  gate.resolve(undefined);
  await settle();
  assert.equal(oldOutput.frames.some((frame) => frame.type === "transcript_snapshot_page"), false);
  assert.equal(nextOutput.frames.some((frame) => frame.type === "transcript_snapshot_page"), false);
  channel.disconnected(true);
});

test("oversized canonical transcript is rejected before a snapshot page is materialized", async () => {
  const source = new Source(["s1"]);
  const repository = new TranscriptPublicationRepository({
    source,
    flush: async () => {},
    readCommitted: () => [entry("e1"), entry("e2"), entry("e3")],
    maxSnapshotEvents: 2,
    subscribeCommits: () => () => {},
  });
  const channel = new TranscriptChannel({ repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  await snapshot(channel, output.sender, "oversized-snapshot", "s1");

  assert.equal(output.frames.some((frame) => frame.type === "transcript_snapshot_page"), false);
  assert.equal(output.frames.at(-1)?.code, "SNAPSHOT_TOO_LARGE");
  channel.disconnected(true);
});

test("large canonical events stay local while reverse frames carry bounded truncation and artifact identity", () => {
  const large = entry("large-1", "user", {
    author: "operator@example.test",
    usage: { output_tokens: 99 },
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "tool",
        content: "secret-shaped but authorized transcript data ".repeat(20_000),
      }],
    },
  });
  const published = publishedTranscriptEvent("s1", "epoch", 7, large);
  assert.equal(published.eventId, "large-1");
  assert.equal(published.seq, 7);
  assert.equal(published.eventType, "user");
  assert.equal(published.author, "operator@example.test");
  assert.deepEqual(published.usage, { output_tokens: 99 });
  assert.ok(published.truncation);
  assert.equal(published.truncation?.artifact.eventId, "large-1");
  assert.ok(transcriptDurableEnvelopeBytes(published) <= MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES);
});

test("adversarial author and nested usage stay local while the complete durable envelope remains bounded", async () => {
  const hugeAuthor = "operator-".repeat(90_000);
  const hugeUsageValue = "usage-metadata-".repeat(100_000);
  const large = entry("wire-large", "result", {
    author: hugeAuthor,
    usage: {
      input_tokens: 7,
      nested: {
        vendor: {
          metadata: hugeUsageValue,
        },
      },
    },
    providerMetadata: "top-level-".repeat(100_000),
  });
  const published = publishedTranscriptEvent("s1", "epoch", 1, large);
  assert.equal(large.event.author, hugeAuthor);
  assert.equal(
    ((large.event.usage as { nested: { vendor: { metadata: string } } }).nested.vendor.metadata),
    hugeUsageValue,
  );
  assert.ok(published.truncation);
  assert.deepEqual(published.truncation?.artifact, {
    kind: "session_transcript_event",
    sessionId: "s1",
    eventId: "wire-large",
  });
  assert.equal(published.truncation?.retainedBytes, transcriptDurableEnvelopeBytes(published));
  assert.ok((published.truncation?.originalBytes ?? 0) > MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES);
  assert.ok(transcriptDurableEnvelopeBytes(published) <= MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES);

  const fixture = repositoryFixture(["s1"], { s1: [] });
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  await snapshot(channel, output.sender, "wire-snapshot", "s1");
  fixture.append("s1", large);

  const durable = output.durableFrames.at(-1)!;
  const completeWire = {
    type: "durable_message",
    epoch: "delivery",
    cursor: durable.cursor,
    messageId: `message-${durable.cursor}`,
    priority: durable.options?.priority,
    capability: durable.options?.capability,
    payload: durable.frame,
  };
  assert.equal(durable.frame.type, "transcript_live_event");
  assert.equal(durable.options?.priority, "critical");
  assert.ok(Buffer.byteLength(JSON.stringify(completeWire)) <= MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES);
  assert.deepEqual(output.disconnects, []);
  channel.disconnected(true);
});

test("subscribed deletion is a critical durable terminal signal and removes cross-session state", async () => {
  const fixture = repositoryFixture(["s1"], { s1: [entry("e1")] });
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  await snapshot(channel, output.sender, "snapshot-delete", "s1");
  fixture.source.remove("s1");

  const deleted = output.durableFrames.at(-1)!;
  assert.equal(deleted.frame.type, "transcript_deleted");
  assert.equal(deleted.frame.sessionId, "s1");
  assert.equal(deleted.options?.priority, "critical");
  channel.receive({
    type: "transcript_subscribe",
    requestId: "after-delete",
    sessionId: "s1",
    epoch: deleted.frame.epoch,
    afterSeq: 1,
  }, output.sender);
  await settle();
  assert.equal(output.frames.at(-1)?.code, "UNKNOWN_SESSION");
  channel.disconnected(true);
});

test("OUTBOX_FULL keeps deletion and snapshot state until durable admission can retry", async () => {
  const fixture = repositoryFixture(["s1"], { s1: [entry("e1"), entry("e2")] });
  let now = 1_000;
  const channel = new TranscriptChannel({ repository: fixture.repository, now: () => now });
  const output = capture();
  channel.negotiated(true, {}, output.sender);
  await snapshot(channel, output.sender, "delete-backpressure", "s1", true, 1);
  const firstPage = output.frames.find((frame) => frame.type === "transcript_snapshot_page")!;

  output.failDurable("OUTBOX_FULL");
  fixture.source.remove("s1");
  assert.equal(output.durableFrames.some(({ frame }) => frame.type === "transcript_deleted"), false);
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "delete-backpressure",
    sessionId: "s1",
    cursor: firstPage.nextCursor,
  }, output.sender);
  assert.equal(output.frames.at(-1)?.type, "transcript_snapshot_page");

  now += TRANSCRIPT_SNAPSHOT_TTL_MS;
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "delete-backpressure",
    sessionId: "s1",
    cursor: firstPage.nextCursor,
  }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "CURSOR_UNAVAILABLE");

  output.failDurable(null);
  channel.durableAcknowledged("unrelated-cumulative-cursor");
  assert.equal(output.durableFrames.at(-1)?.frame.type, "transcript_deleted");
  channel.receive({
    type: "transcript_snapshot_request",
    requestId: "delete-backpressure",
    sessionId: "s1",
    cursor: firstPage.nextCursor,
  }, output.sender);
  assert.equal(output.frames.at(-1)?.code, "CURSOR_UNAVAILABLE");
  channel.disconnected(true);
});

test("PERSIST_FAILED deletion retries on reconnect before demand state is discarded", async () => {
  const fixture = repositoryFixture(["s1"], { s1: [entry("e1")] });
  const channel = new TranscriptChannel({ repository: fixture.repository });
  const firstOutput = capture();
  channel.negotiated(true, {}, firstOutput.sender);
  await snapshot(channel, firstOutput.sender, "delete-persist", "s1");

  firstOutput.failDurable("PERSIST_FAILED");
  fixture.source.remove("s1");
  assert.equal(firstOutput.durableFrames.some(({ frame }) => frame.type === "transcript_deleted"), false);

  channel.disconnected(false);
  const reconnected = capture();
  channel.negotiated(true, {}, reconnected.sender);
  assert.equal(reconnected.durableFrames.length, 1);
  assert.equal(reconnected.durableFrames[0]?.frame.type, "transcript_deleted");
  assert.equal(reconnected.durableFrames[0]?.frame.sessionId, "s1");
  assert.equal(reconnected.durableFrames[0]?.options?.priority, "critical");
  channel.disconnected(true);
});
