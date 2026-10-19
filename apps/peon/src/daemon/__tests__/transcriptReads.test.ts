import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-transcript-reads-state-"));

const {
  appendTranscriptEvent,
  findTranscriptEntry,
  flushTranscript,
  readCommittedTranscriptTail,
  readTranscriptEntries,
  sessionsDir,
  transcriptPath,
} = await import("../sessions/sessionArtifacts.js");

function writeRows(id: string, texts: string[], persistedIds = true): void {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(transcriptPath(id), texts.map((text, index) => `${JSON.stringify({
    type: "user_message",
    text,
    ...(persistedIds ? { _peonEventId: `${id}-${index}` } : {}),
  })}\n`).join(""));
}

const texts = (entries: Array<{ event: { text?: unknown } }>) => entries.map((entry) => entry.event.text);

test("an append before any read never hides the history already on disk", async () => {
  // A daemon restart leaves history on disk and nothing in memory. The first
  // in-process append used to become the whole in-memory transcript.
  writeRows("restart-append", ["one", "two", "three"]);
  appendTranscriptEvent("restart-append", { type: "user_message", text: "four" });
  assert.deepEqual(texts(readTranscriptEntries("restart-append", "claude-code")), ["one", "two", "three", "four"]);
  await flushTranscript("restart-append");
  assert.deepEqual(texts(readTranscriptEntries("restart-append", "claude-code")), ["one", "two", "three", "four"]);
});

test("accepted events are readable before their append commits, exactly once after", async () => {
  writeRows("pending-tail", ["old"]);
  const accepted = appendTranscriptEvent("pending-tail", { type: "user_message", text: "new" });
  const before = readTranscriptEntries("pending-tail", "claude-code");
  assert.deepEqual(texts(before), ["old", "new"]);
  assert.equal(before.at(-1)?.id, accepted.id);
  assert.equal(findTranscriptEntry("pending-tail", "claude-code", accepted.id)?.id, accepted.id);
  await flushTranscript("pending-tail");
  const after = readTranscriptEntries("pending-tail", "claude-code");
  assert.deepEqual(after.map((entry) => entry.id), before.map((entry) => entry.id));
});

test("one event is found by persisted or legacy id without changing identity", () => {
  writeRows("lookup", ["a", "b", "c"]);
  const all = readTranscriptEntries("lookup", "claude-code");
  assert.deepEqual(findTranscriptEntry("lookup", "claude-code", "lookup-1"), all[1]);
  assert.equal(findTranscriptEntry("lookup", "claude-code", "missing"), null);
  assert.equal(findTranscriptEntry("no-such-session", "claude-code", "lookup-1"), null);

  writeRows("legacy-lookup", ["x", "y"], false);
  const legacy = readTranscriptEntries("legacy-lookup", "claude-code");
  assert.ok(legacy[1]?.id.startsWith("legacy_"));
  assert.deepEqual(findTranscriptEntry("legacy-lookup", "claude-code", legacy[1]!.id), legacy[1]);
});

test("event lookup agrees with the full parse on nested, duplicate and hidden ids", () => {
  mkdirSync(sessionsDir, { recursive: true });
  const row = (fields: Record<string, unknown>) => `${JSON.stringify({ type: "user_message", ...fields })}\n`;
  writeFileSync(transcriptPath("tricky-ids"), [
    // A nested object carrying the key is content, not the row identity.
    row({ text: "nested", input: { _peonEventId: "ghost" } }),
    // A row normalization hides does not claim its id.
    `${JSON.stringify({ type: "system", subtype: "thinking_tokens", _peonEventId: "dup" })}\n`,
    row({ text: "first", _peonEventId: "dup" }),
    row({ text: "copy", _peonEventId: "dup" }),
  ].join(""));
  const all = readTranscriptEntries("tricky-ids", "claude-code");
  assert.deepEqual(texts(all), ["nested", "first", "copy"]);
  assert.equal(findTranscriptEntry("tricky-ids", "claude-code", "ghost"), null);
  assert.deepEqual(findTranscriptEntry("tricky-ids", "claude-code", "dup"), all[1]);
  // The copied row's derived id still resolves through the full parse.
  assert.ok(all[2]!.id.startsWith("legacy_"));
  assert.deepEqual(findTranscriptEntry("tricky-ids", "claude-code", all[2]!.id), all[2]);
});

test("the stream tail replays everything after a known boundary, however far back", async () => {
  const rows = Array.from({ length: 1_200 }, (_, index) => `row-${index}`);
  writeRows("long-tail", rows);
  const afterOld = await readCommittedTranscriptTail("long-tail", "claude-code", "long-tail-99", 50);
  assert.equal(afterOld.length, 1_100);
  assert.equal(afterOld[0]?.event.text, "row-100");
  assert.equal(afterOld.at(-1)?.event.text, "row-1199");
  assert.equal(afterOld[0]?.id, "long-tail-100");
  assert.equal("eventId" in afterOld[0]!.event, false);

  assert.deepEqual(await readCommittedTranscriptTail("long-tail", "claude-code", "long-tail-1199", 50), []);
  assert.deepEqual(texts(await readCommittedTranscriptTail("long-tail", "claude-code", "long-tail-1197", 50)), ["row-1198", "row-1199"]);
  writeRows("legacy-tail", rows.slice(0, 120), false);
  const legacyRows = readTranscriptEntries("legacy-tail", "claude-code");
  assert.deepEqual(texts(await readCommittedTranscriptTail("legacy-tail", "claude-code", legacyRows[9]!.id, 50)), rows.slice(10, 120));
  const unknown = await readCommittedTranscriptTail("long-tail", "claude-code", "not-in-this-session", 50);
  assert.deepEqual(texts(unknown), rows.slice(-50));
  const fresh = await readCommittedTranscriptTail("long-tail", "claude-code", undefined, 50);
  assert.deepEqual(texts(fresh), rows.slice(-50));
  assert.deepEqual(await readCommittedTranscriptTail("empty-tail", "claude-code", undefined, 50), []);
});
