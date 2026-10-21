import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateRoot = mkdtempSync(path.join(os.tmpdir(), "peon-message-threads-"));
process.env.XDG_STATE_HOME = stateRoot;

const threads = await import("../sessions/messageThreads.js");
const artifacts = await import("../sessions/sessionArtifacts.js");

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

const source = {
  id: "source-session", agent: "claude-code" as const, title: "Source", dir: os.tmpdir(), projectKey: null,
  model: null, reasoningEffort: null,
} as never;
const command = (suffix: string) => `018f06c2-1c2a-7b35-8f2d-6f2f9024ac${suffix}`;
const alice = { kind: "user" as const, id: "alice", label: "Alice" };

test("keeps thread discussion outside the source transcript and replays commands", async () => {
  artifacts.appendTranscriptEvent(source.id, { type: "user_message", text: "Original question" }, Date.now, "event-user");
  artifacts.appendTranscriptEvent(source.id, { type: "assistant", message: { content: [{ type: "text", text: "Original answer" }] } }, Date.now, "event-answer");
  await artifacts.flushTranscript(source.id);
  const before = readFileSync(artifacts.transcriptPath(source.id), "utf8");

  const created = await threads.createThread(source, "event-answer", command("11"));
  assert.deepEqual(await threads.createThread(source, "event-answer", command("11")), created);
  const discussed = await threads.appendThreadMessage(source.id, created.id, command("12"), "Please focus on retries", alice);
  assert.equal(discussed.messages.length, 1);
  const discussionSummary = threads.messageThreadAnchors(source.id).get("event-answer");
  assert.deepEqual(discussionSummary, {
    threadId: created.id,
    messageCount: 1,
    activityStatus: "discussion",
    updatedAt: discussed.updatedAt,
  });
  const decorated = threads.withMessageThreadAnchor(
    { type: "assistant", message: { content: [] } },
    "event-answer",
    threads.messageThreadAnchors(source.id),
  );
  assert.deepEqual(decorated.messageThread, discussionSummary);
  assert.equal(readFileSync(artifacts.transcriptPath(source.id), "utf8"), before);
  await assert.rejects(
    threads.appendThreadMessage(source.id, created.id, command("12"), "Different", alice),
    (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
  );
});

test("creates one linked session with a bounded private capsule", async () => {
  const thread = threads.listThreads(source.id)[0]!;
  const starts: unknown[] = [];
  const invoked = await threads.invokeThread(source, thread.id, command("13"), undefined, "alice@example.test", (options) => {
    starts.push(options);
    return { id: options.id } as never;
  });
  assert.equal(starts.length, 1);
  const options = starts[0] as { bootstrapContext: string; threadSource: unknown; prompt: string };
  assert.match(options.bootstrapContext, /Original answer/);
  assert.match(options.bootstrapContext, /Please focus on retries/);
  assert.ok(options.threadSource);
  assert.ok(invoked.agentSessionId);
  assert.equal(threads.messageThreadAnchors(source.id).get("event-answer")?.activityStatus, "active");
  const replay = await threads.invokeThread(source, thread.id, command("13"), undefined, "alice@example.test", () => {
    throw new Error("must not start twice");
  });
  assert.equal(replay.agentSessionId, invoked.agentSessionId);
  assert.equal(readFileSync(artifacts.transcriptPath(source.id), "utf8").includes("Please focus on retries"), false);
  await assert.rejects(threads.appendThreadMessage(source.id, thread.id, command("14"), "too late", alice), (error: unknown) => (error as { code?: string }).code === "THREAD_INVOKED");
});

test("retries a crash after invoke reservation with the same session id", async () => {
  const retrySource = { ...source, id: "invoke-retry" } as never;
  artifacts.appendTranscriptEvent("invoke-retry", { type: "assistant", message: { content: [{ type: "text", text: "Anchor" }] } }, Date.now, "anchor");
  await artifacts.flushTranscript("invoke-retry");
  const thread = await threads.createThread(retrySource, "anchor", command("21"));
  let reservedId: string | undefined;
  await assert.rejects(
    threads.invokeThread(retrySource, thread.id, command("22"), "continue", "alice@example.test", (options) => {
      reservedId = options.id;
      throw new Error("simulated crash before session creation");
    }),
    /simulated crash/,
  );
  const recovered = await threads.invokeThread(retrySource, thread.id, command("22"), "continue", "alice@example.test", (options) => {
    assert.equal(options.id, reservedId);
    return { id: options.id } as never;
  });
  assert.equal(recovered.agentSessionId, reservedId);
  assert.equal(recovered.invokeState, "started");
});

test("rejects malformed messages, prompts, principals, and non-message anchors with stable errors", async () => {
  const invalidSource = { ...source, id: "invalid-input" } as never;
  artifacts.appendTranscriptEvent("invalid-input", { type: "warning", text: "not a message" }, Date.now, "warning-anchor");
  artifacts.appendTranscriptEvent("invalid-input", { type: "assistant", message: { content: [{ type: "text", text: "Replyable" }] } }, Date.now, "valid-anchor");
  await artifacts.flushTranscript("invalid-input");
  await assert.rejects(threads.createThread(invalidSource, "warning-anchor", command("31")), (error: unknown) => (error as { code?: string }).code === "BAD_THREAD");
  const thread = await threads.createThread(invalidSource, "valid-anchor", command("32"));
  await assert.rejects(threads.appendThreadMessage("invalid-input", thread.id, command("33"), null as never, alice), (error: unknown) => (error as { code?: string }).code === "BAD_THREAD");
  await assert.rejects(threads.appendThreadMessage("invalid-input", thread.id, command("34"), "hello", { ...alice, label: "x".repeat(81) }), (error: unknown) => (error as { code?: string }).code === "BAD_THREAD");
  await assert.rejects(threads.invokeThread(invalidSource, thread.id, command("35"), {} as never, undefined, () => makeRecordStub()), (error: unknown) => (error as { code?: string }).code === "BAD_THREAD");
});

test("bounds the complete capsule and never exposes its body in thread views", async () => {
  const boundedSource = { ...source, id: "bounded-capsule" } as never;
  artifacts.appendTranscriptEvent("bounded-capsule", { type: "assistant", message: { content: [{ type: "text", text: "Anchor" }] } }, Date.now, "bounded-anchor");
  await artifacts.flushTranscript("bounded-capsule");
  let thread = await threads.createThread(boundedSource, "bounded-anchor", command("41"));
  for (let index = 0; index < 10; index++) {
    thread = await threads.appendThreadMessage("bounded-capsule", thread.id, command(`${50 + index}`), "😀".repeat(4_000), alice);
  }
  let bootstrap = "";
  const invoked = await threads.invokeThread(boundedSource, thread.id, command("70"), undefined, undefined, (options) => {
    bootstrap = options.bootstrapContext ?? "";
    return makeRecordStub();
  });
  assert.ok(Buffer.byteLength(bootstrap) <= 128 * 1024);
  assert.equal("capsule" in invoked, false);
  assert.equal("invokeCommandId" in invoked, false);
  assert.equal(invoked.hasCapsule, true);
});

test("fails closed before materializing an oversized transcript", async () => {
  const oversizedSource = { ...source, id: "oversized-transcript" } as never;
  artifacts.appendTranscriptEvent("oversized-transcript", { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }] } }, Date.now, "oversized-anchor");
  await artifacts.flushTranscript("oversized-transcript");
  await assert.rejects(threads.createThread(oversizedSource, "oversized-anchor", command("81")), (error: unknown) => (error as { code?: string }).code === "TRANSCRIPT_TOO_LARGE");
});

test("serializes concurrent invokes and starts exactly one linked session", async () => {
  const concurrentSource = { ...source, id: "concurrent-invoke" } as never;
  artifacts.appendTranscriptEvent("concurrent-invoke", { type: "assistant", message: { content: [{ type: "text", text: "Anchor" }] } }, Date.now, "concurrent-anchor");
  await artifacts.flushTranscript("concurrent-invoke");
  const thread = await threads.createThread(concurrentSource, "concurrent-anchor", command("82"));
  const started: string[] = [];
  const start = (options: { id?: string }) => {
    started.push(options.id!);
    return { id: options.id } as never;
  };
  const [first, second] = await Promise.all([
    threads.invokeThread(concurrentSource, thread.id, command("83"), "continue", undefined, start),
    threads.invokeThread(concurrentSource, thread.id, command("84"), "continue", undefined, start),
  ]);
  assert.equal(started.length, 1);
  assert.equal(first.agentSessionId, second.agentSessionId);
});

function makeRecordStub() {
  return { id: randomUUID() } as never;
}
