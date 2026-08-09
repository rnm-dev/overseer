import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-transcript-page-state-"));

const {
  appendTranscriptEvent,
  flushTranscript,
  forgetTranscript,
  observeTranscriptReads,
  readTranscriptEntries,
  readTranscriptPage,
  sessionsDir,
  transcriptIndexMetaPath,
  transcriptIndexPath,
  transcriptPath,
} = await import("../sessions/sessionArtifacts.js");
const { TranscriptPaginationError } = await import("../sessions/transcriptPagination.js");

function row(index: number, payload = ""): string {
  return JSON.stringify({
    type: "user_message",
    text: `${index}:${payload}`,
    _peonEventId: `event-${index}`,
  });
}

test("a cold restart reads a bounded tail from a large indexed transcript", async () => {
  mkdirSync(sessionsDir, { recursive: true });
  const id = "large-bounded-tail";
  const rows = 20_000;
  const payload = "x".repeat(512);
  writeFileSync(transcriptPath(id), `${Array.from({ length: rows }, (_, index) => row(index, payload)).join("\n")}\n`);

  // Upgrade/recovery pays the one-time asynchronous indexing cost.
  await readTranscriptPage(id, "claude-code", { limit: 50 });
  forgetTranscript(id);

  let observed: Parameters<NonNullable<Parameters<typeof observeTranscriptReads>[0]>>[0] | null = null;
  observeTranscriptReads((metrics) => { observed = metrics; });
  const page = await readTranscriptPage(id, "claude-code", { limit: 50 });
  observeTranscriptReads(null);

  assert.equal(page.events.length, 50);
  assert.equal(page.events[0].eventId, `event-${rows - 50}`);
  assert.equal(page.events.at(-1)?.eventId, `event-${rows - 1}`);
  assert.ok(observed);
  assert.equal(observed.cold, true);
  assert.equal(observed.indexRebuilt, false);
  assert.equal(observed.rowsParsed, 50);
  assert.ok(observed.fileBytesExamined < 50_000, `examined ${observed.fileBytesExamined} transcript bytes`);
});

test("older cursors stay anchored while an append commits, and copied/corrupt rows keep stable ids", async () => {
  const id = "bounded-cursor-append";
  const copied = JSON.stringify({ type: "user_message", text: "copy", _peonEventId: "copied-id" });
  writeFileSync(
    transcriptPath(id),
    `${row(0)}\n${copied}\n{malformed}\n${copied}\n${row(4)}\n{"partial":`,
  );
  const newest = await readTranscriptPage(id, "claude-code", { limit: 2 });
  assert.deepEqual(newest.events.map((event) => event.text), ["copy", "4:"]);
  assert.equal(new Set(newest.events.map((event) => event.eventId)).size, 2);

  appendTranscriptEvent(id, { type: "user_message", text: "new" });
  const older = await readTranscriptPage(id, "claude-code", { limit: 2, cursor: newest.nextCursor! });
  assert.deepEqual(older.events.map((event) => event.text), ["0:", "copy"]);
  const afterAppend = await readTranscriptPage(id, "claude-code", { limit: 1 });
  assert.equal(afterAppend.events[0].text, "new");
  await flushTranscript(id);

  forgetTranscript(id);
  const all = readTranscriptEntries(id, "claude-code");
  assert.equal(new Set(all.map((entry) => entry.id)).size, all.length);
  assert.deepEqual(newest.events.map((event) => event.eventId), all.slice(2, 4).map((entry) => entry.id));
  assert.equal(all.at(-1)?.event.text, "new");
});

test("same-size corruption at an older-page cursor self-heals without changing transcript data", async () => {
  const id = "corrupt-index-recovery";
  writeFileSync(transcriptPath(id), `${Array.from({ length: 20 }, (_, index) => row(index)).join("\n")}\n`);
  const first = await readTranscriptPage(id, "claude-code", { limit: 5 });
  const transcriptBefore = readFileSync(transcriptPath(id));
  const cursorPayload = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as { beforeIndexOffset: number };
  const index = readFileSync(transcriptIndexPath(id));
  const newline = index.indexOf(0x0a, cursorPayload.beforeIndexOffset);
  index.fill(0x78, cursorPayload.beforeIndexOffset, Math.min(newline, cursorPayload.beforeIndexOffset + 8));
  writeFileSync(transcriptIndexPath(id), index);
  forgetTranscript(id);

  let recovered = false;
  observeTranscriptReads((metrics) => { recovered = metrics.indexRecovered; });
  const second = await readTranscriptPage(id, "claude-code", { limit: 5, cursor: first.nextCursor! });
  observeTranscriptReads(null);
  assert.deepEqual(second.events.map((event) => event.eventId), ["event-10", "event-11", "event-12", "event-13", "event-14"]);
  assert.equal(recovered, true);
  assert.deepEqual(readFileSync(transcriptPath(id)), transcriptBefore);
});

test("an asynchronous cold index rebuild yields to unrelated event-loop work", async () => {
  const id = "responsive-index-rebuild";
  const payload = "z".repeat(1_024);
  writeFileSync(transcriptPath(id), `${Array.from({ length: 12_000 }, (_, index) => row(index, payload)).join("\n")}\n`);
  rmSync(transcriptIndexPath(id), { force: true });
  rmSync(transcriptIndexMetaPath(id), { force: true });
  forgetTranscript(id);

  let unrelatedCompleted = false;
  const pagePromise = readTranscriptPage(id, "claude-code", { limit: 50 });
  const unrelated = new Promise<void>((resolve) => setTimeout(() => {
    unrelatedCompleted = true;
    resolve();
  }, 0));
  await unrelated;
  assert.equal(unrelatedCompleted, true);
  const page = await pagePromise;
  assert.equal(page.events.length, 50);
});

test("a forged indexed cursor is rejected without rebuilding or scanning the full index", async () => {
  const id = "forged-index-offset";
  writeFileSync(transcriptPath(id), `${Array.from({ length: 1_000 }, (_, index) => row(index)).join("\n")}\n`);
  await readTranscriptPage(id, "claude-code", { limit: 10 });

  const forged = Buffer.from(JSON.stringify({
    version: 2,
    sessionId: id,
    beforeEventId: "event-500",
    beforeIndexOffset: 1,
  })).toString("base64url");
  let observed: { indexRebuilt: boolean; indexBytesExamined: number } | null = null;
  observeTranscriptReads((metrics) => { observed = metrics; });
  await assert.rejects(
    () => readTranscriptPage(id, "claude-code", { limit: 10, cursor: forged }),
    (error: unknown) => error instanceof TranscriptPaginationError && error.code === "BAD_CURSOR",
  );
  observeTranscriptReads(null);
  assert.ok(observed);
  assert.equal(observed.indexRebuilt, false);
  assert.ok(observed.indexBytesExamined <= 64 * 1024);

  const valid = await readTranscriptPage(id, "claude-code", { limit: 10 });
  assert.equal(valid.events.length, 10);
  assert.equal(valid.events.at(-1)?.eventId, "event-999");
});

test("an indexed append stays warm and is immediately visible to newest-page pagination", async () => {
  const id = "warm-indexed-append";
  writeFileSync(transcriptPath(id), `${row(0)}\n${row(1)}\n`);
  await readTranscriptPage(id, "claude-code", { limit: 1 });
  appendTranscriptEvent(id, { type: "user_message", text: "appended" });

  let observed: { cold: boolean; indexRebuilt: boolean; rowsParsed: number } | null = null;
  observeTranscriptReads((metrics) => { observed = metrics; });
  const page = await readTranscriptPage(id, "claude-code", { limit: 1 });
  observeTranscriptReads(null);
  assert.equal(page.events[0].text, "appended");
  assert.ok(observed);
  assert.equal(observed.cold, false);
  assert.equal(observed.indexRebuilt, false);
  assert.equal(observed.rowsParsed, 1);
});

test("repeated bounded cursors visit every valid event exactly once across index chunks", async () => {
  const id = "all-pages-across-index-chunks";
  const physicalRows = Array.from({ length: 1_200 }, (_, index) =>
    index % 17 === 0 ? "{malformed" : row(index),
  );
  writeFileSync(transcriptPath(id), `${physicalRows.join("\n")}\n`);
  const expected = readTranscriptEntries(id, "claude-code").map((entry) => entry.id);
  forgetTranscript(id);

  const visited: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await readTranscriptPage(id, "claude-code", { limit: 37, cursor });
    visited.unshift(...page.events.map((event) => event.eventId));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    assert.ok(page.events.length <= 37);
  } while (cursor);

  assert.ok(pages > 20);
  assert.deepEqual(visited, expected);
  assert.equal(new Set(visited).size, visited.length);
});
