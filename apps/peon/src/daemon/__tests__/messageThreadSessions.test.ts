import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateRoot = mkdtempSync(path.join(os.tmpdir(), "peon-thread-sessions-"));
process.env.XDG_STATE_HOME = stateRoot;
process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-thread-sessions-config-"));

const { sessions } = await import("../sessions/index.js");
const { appendTranscriptEvent, flushTranscript } = await import("../sessions/sessionArtifacts.js");
const { toSessionSummary } = await import("../sessions/sessionSummary.js");

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

test("a newly created thread is immediately a first-class dormant session", async () => {
  const source = sessions.start({ prompt: "Source", dir: os.tmpdir(), agent: "claude-code", deferStart: true });
  appendTranscriptEvent(source.id, { type: "assistant", message: { content: [{ type: "text", text: "Anchor answer" }] } }, Date.now, "anchor-answer");
  await flushTranscript(source.id);

  const thread = await sessions.createMessageThread(source.id, "anchor-answer", "018f06c2-1c2a-7b35-8f2d-6f2f9024ac91");
  const record = sessions.get(thread.id);
  assert.ok(record);
  assert.equal(record.kind, "thread");
  assert.equal(record.threadState, "discussion");
  assert.equal(record.status, "completed");
  assert.deepEqual(record.threadSource, { sessionId: source.id, threadId: thread.id, anchorEventId: "anchor-answer" });
  assert.equal(thread.agentSessionId, thread.id);
  assert.ok(sessions.list().some((item) => item.id === thread.id));
  assert.ok(sessions.page({ limit: 100 }).sessions.some((item) => item.id === thread.id));

  const summary = toSessionSummary(record);
  assert.equal(summary.kind, "thread");
  assert.equal(summary.threadState, "discussion");
  assert.equal(summary.threadSource?.sessionId, source.id);

  await sessions.appendMessageThreadMessage(
    source.id,
    thread.id,
    "018f06c2-1c2a-7b35-8f2d-6f2f9024ac92",
    "One reply",
    { kind: "user", id: "alice", label: "Alice" },
  );
  const transcript = sessions.getTranscript(source.id);
  const messageThread = transcript[0]?.messageThread as Record<string, unknown>;
  assert.equal(messageThread.threadId, thread.id);
  assert.equal(messageThread.messageCount, 1);
  assert.equal(messageThread.activityStatus, "discussion");
  assert.equal(typeof messageThread.updatedAt, "number");
  const page = await sessions.getTranscriptPage(source.id, { limit: 10 });
  assert.deepEqual(page.events[0]?.messageThread, transcript[0]?.messageThread);
});
