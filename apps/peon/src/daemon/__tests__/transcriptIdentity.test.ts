import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-transcript-id-state-"));

const {
  appendTranscriptEvent,
  CommittedTranscriptLimitError,
  discardTranscript,
  flushTranscript,
  forgetTranscript,
  readCommittedTranscriptEntries,
  readCommittedTranscriptEntriesBounded,
  readTranscriptEntries,
  sessionsDir,
  subscribeTranscriptCommits,
  transcriptPath,
} = await import("../sessions/sessionArtifacts.js");
const { paginateTranscript } = await import("../transcriptPagination.js");

test("legacy, duplicate, corrupt, and newly persisted rows keep stable distinct ids across reload", async () => {
  mkdirSync(sessionsDir, { recursive: true });
  const id = "identity-session";
  const duplicate = JSON.stringify({ type: "user_message", text: "same payload" });
  writeFileSync(transcriptPath(id), `${duplicate}\n{broken json\n${duplicate}\n${JSON.stringify({ type: "user_message", text: "oldest" })}\n`);

  const first = readTranscriptEntries(id, "claude-code");
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map((entry) => entry.id)).size, 3);
  assert.ok(first.every((entry) => entry.id.startsWith("legacy_")));
  const newestPage = paginateTranscript(id, first, { limit: 1 });

  forgetTranscript(id);
  const reloaded = readTranscriptEntries(id, "claude-code");
  assert.deepEqual(reloaded.map((entry) => entry.id), first.map((entry) => entry.id));
  const reloadedOlderPage = paginateTranscript(id, reloaded, { limit: 1, cursor: newestPage.nextCursor! });
  assert.equal(reloadedOlderPage.events.length, 1);

  const sourceTimestamp = "2026-07-16T08:06:23.942Z";
  const appended = appendTranscriptEvent(id, { type: "user_message", text: "new", createdAt: 1, sourceTimestamp }, () => 1_783_000_000_123);
  assert.equal(appended.event.createdAt, 1_783_000_000_123);
  await flushTranscript(id);
  forgetTranscript(id);
  const final = readTranscriptEntries(id, "claude-code");
  assert.equal(final.at(-1)?.id, appended.id);
  assert.equal(final.at(-1)?.event.createdAt, 1_783_000_000_123);
  assert.equal(final.at(-1)?.event.sourceTimestamp, sourceTimestamp);
  assert.equal(new Set(final.map((entry) => entry.id)).size, 4);
});

test("append snapshots nested event data and deletion wins over queued persistence", async () => {
  const id = "immutable-then-deleted";
  const event = {
    type: "assistant" as const,
    message: { content: [{ type: "text", text: "committed" }] },
  };
  const entry = appendTranscriptEvent(id, event, () => 123);
  event.message.content[0].text = "mutated later";
  assert.equal((entry.event.message as { content: Array<{ text: string }> }).content[0].text, "committed");

  await discardTranscript(id);
  assert.equal(existsSync(transcriptPath(id)), false);
});

test("a canonical branch copy can preserve an event id and reply provenance", async () => {
  const id = "branch-preserved-identity";
  const eventId = "source_event_123";
  appendTranscriptEvent(id, {
    type: "assistant",
    message: { content: [{ type: "text", text: "selected source text" }] },
  }, () => 788, eventId);
  appendTranscriptEvent(id, {
    type: "user_message",
    text: "Please address this selection",
    replyTo: { eventId, selectedText: "selected source text" },
  }, () => 789, "reply_event_456");
  await flushTranscript(id);
  forgetTranscript(id);
  const entries = readTranscriptEntries(id, "claude-code");
  assert.deepEqual(entries.map((entry) => entry.id), [eventId, "reply_event_456"]);
  assert.deepEqual(entries[1]?.event.replyTo, { eventId, selectedText: "selected source text" });
});

test("reverse publication notification crosses only after the canonical JSONL append", async () => {
  const id = "commit-boundary";
  const committed: string[] = [];
  const unsubscribe = subscribeTranscriptCommits((payload) => {
    if (payload.sessionId === id) committed.push(payload.entry.id);
  });
  try {
    const appended = appendTranscriptEvent(id, { type: "user_message", text: "durable first" }, () => 456);
    assert.deepEqual(committed, []);
    await flushTranscript(id);
    assert.deepEqual(committed, [appended.id]);
    assert.deepEqual(readCommittedTranscriptEntries(id, "claude-code").map((item) => item.id), [appended.id]);
  } finally {
    unsubscribe();
  }
});

test("bounded committed reader stops oversized canonical transcripts by bytes, line, and event count", () => {
  const id = "bounded-committed-reader";
  mkdirSync(sessionsDir, { recursive: true });
  const rows = [
    JSON.stringify({ type: "user_message", text: "a".repeat(256), _peonEventId: "bounded-1" }),
    JSON.stringify({ type: "assistant", message: { content: "b".repeat(256) }, _peonEventId: "bounded-2" }),
    JSON.stringify({ type: "result", usage: { nested: "c".repeat(256) }, _peonEventId: "bounded-3" }),
  ];
  writeFileSync(transcriptPath(id), `${rows.join("\n")}\n`);

  assert.throws(
    () => readCommittedTranscriptEntriesBounded(id, "claude-code", {
      maxEvents: 2,
      maxSourceBytes: 8 * 1024,
      maxLineBytes: 2 * 1024,
    }),
    (error: unknown) => error instanceof CommittedTranscriptLimitError && error.limit === "events",
  );
  assert.throws(
    () => readCommittedTranscriptEntriesBounded(id, "claude-code", {
      maxEvents: 10,
      maxSourceBytes: 128,
      maxLineBytes: 2 * 1024,
    }),
    (error: unknown) => error instanceof CommittedTranscriptLimitError && error.limit === "source_bytes",
  );
  assert.throws(
    () => readCommittedTranscriptEntriesBounded(id, "claude-code", {
      maxEvents: 10,
      maxSourceBytes: 8 * 1024,
      maxLineBytes: 128,
    }),
    (error: unknown) => error instanceof CommittedTranscriptLimitError && error.limit === "line_bytes",
  );
});

test("unsafe persisted event ids are replaced with deterministic safe identities", () => {
  const id = "unsafe-persisted-id";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(transcriptPath(id), `${JSON.stringify({
    type: "user_message",
    text: "safe payload",
    _peonEventId: "forged\nid: injected",
  })}\n`);
  const [entry] = readTranscriptEntries(id, "claude-code");
  assert.match(entry.id, /^legacy_[A-Za-z0-9_-]+$/);
  assert.equal(entry.id.includes("\n"), false);
});

test("duplicate persisted ids cannot collapse distinct transcript positions", () => {
  const id = "duplicate-persisted-id";
  mkdirSync(sessionsDir, { recursive: true });
  const row = (text: string) => JSON.stringify({ type: "user_message", text, _peonEventId: "same-id" });
  writeFileSync(transcriptPath(id), `${row("first")}\n${row("second")}\n`);
  const first = readTranscriptEntries(id, "claude-code");
  forgetTranscript(id);
  const second = readTranscriptEntries(id, "claude-code");
  assert.equal(new Set(first.map((entry) => entry.id)).size, 2);
  assert.deepEqual(second.map((entry) => entry.id), first.map((entry) => entry.id));
});

test("session warnings remain first-class events after transcript reload", () => {
  const id = "warning-persistence";
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(transcriptPath(id), `${JSON.stringify({
    type: "warning",
    sessionId: id,
    code: "payload_truncated",
    currentBytes: 5_000_000,
    limitBytes: 4_194_304,
    retainedBytes: 2_000_000,
    logPath: "/tmp/full.log",
    message: "Output was shortened.",
  })}\n`);
  const [entry] = readTranscriptEntries(id, "codex-app-server");
  assert.equal(entry.event.type, "warning");
  assert.equal(entry.event.code, "payload_truncated");
  assert.equal(entry.event.logPath, "/tmp/full.log");
});
