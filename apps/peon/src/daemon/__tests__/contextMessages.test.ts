import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateRoot = mkdtempSync(path.join(os.tmpdir(), "peon-context-messages-"));
process.env.XDG_STATE_HOME = stateRoot;

const context = await import("../sessions/contextMessages.js");
const artifacts = await import("../sessions/sessionArtifacts.js");

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

const alice = { kind: "user" as const, id: "user-1", label: "Alice" };
const bob = { kind: "guest" as const, id: "guest-2", label: "Bob" };
const command = (suffix: string) => `018f06c2-1c2a-7b35-8f2d-6f2f9024ac${suffix}`;
const input = (text: string) => ({ text, author: alice, attachments: [], mentions: [] });

test("validates UTF-16 mention ranges and normalized principals", () => {
  const parsed = context.parseContextMessage({
    text: "😀 @Bob",
    author: alice,
    mentions: [{ startUtf16: 3, lengthUtf16: 4, principal: bob }],
  }, []);
  assert.deepEqual(parsed.mentions[0]?.principal, bob);
  assert.throws(() => context.parseContextMessage({
    text: "😀 Bob", author: alice,
    mentions: [{ startUtf16: 1, lengthUtf16: 2, principal: bob }],
  }, []), (error: unknown) => (error as { code?: string }).code === "BAD_MENTION");
});

test("appends one immutable transcript row and replays an identical command", async () => {
  const sessionId = "append-replay";
  const first = await context.appendContextMessage(sessionId, command("11"), input("hello"));
  const replay = await context.appendContextMessage(sessionId, command("11"), input("hello"));
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.event, first.event);
  assert.equal(artifacts.readTranscriptEntries(sessionId, "missing").length, 1);
  await assert.rejects(
    context.appendContextMessage(sessionId, command("11"), input("changed")),
    (error: unknown) => (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
  );
});

test("claims a fixed high-water range and leaves messages posted during the turn for the next turn", async () => {
  const sessionId = "claim-boundary";
  await context.appendContextMessage(sessionId, command("12"), input("before"));
  const first = context.claimContext(sessionId, "turn-one");
  assert.ok(first?.envelope.includes('"text":"before"'));
  await context.appendContextMessage(sessionId, command("13"), input("during"));
  assert.doesNotMatch(first!.envelope, /during/);
  context.acknowledgeContextClaim(sessionId, "turn-one");
  const second = context.claimContext(sessionId, "turn-two");
  assert.doesNotMatch(second!.envelope, /before/);
  assert.match(second!.envelope, /during/);
});

test("serializes concurrent posts without duplicate sequence numbers", async () => {
  const sessionId = "concurrent-posts";
  const results = await Promise.all([
    context.appendContextMessage(sessionId, command("90"), input("one")),
    context.appendContextMessage(sessionId, command("91"), input("two")),
    context.appendContextMessage(sessionId, command("92"), input("three")),
  ]);
  assert.deepEqual(results.map(({ event }) => event.contextSeq), [1, 2, 3]);
  assert.deepEqual(
    JSON.parse(context.claimContext(sessionId, "concurrent-turn")!.envelope).messages.map((message: { text: string }) => message.text),
    ["one", "two", "three"],
  );
});

test("releases a pre-acceptance claim and recovers the same ordered backlog", async () => {
  const sessionId = "claim-release";
  await context.appendContextMessage(sessionId, command("14"), input("retry me"));
  const first = context.claimContext(sessionId, "failed-turn");
  context.releaseContextClaim(sessionId, "failed-turn");
  const retry = context.claimContext(sessionId, "retry-turn");
  assert.equal(retry?.fromSeq, first?.fromSeq);
  assert.equal(retry?.throughSeq, first?.throughSeq);
  assert.equal(retry?.envelope, first?.envelope);
});

test("uses the byte-exact canonical provider envelope and marks it untrusted", async () => {
  const sessionId = "golden-envelope";
  const event = await context.appendContextMessage(sessionId, command("15"), {
    text: "@Viktor please check this",
    author: { kind: "guest", id: "guest-7", label: "Sam" },
    attachments: [],
    mentions: [{ startUtf16: 0, lengthUtf16: 7, principal: { kind: "user", id: "user-42", label: "Viktor" } }],
  });
  const claim = context.claimContext(sessionId, "turn-golden")!;
  assert.equal(claim.envelope, JSON.stringify({
    version: 1,
    kind: "participant_context",
    messages: [{
      contextSeq: 1,
      createdAt: event.event.createdAt,
      author: { kind: "guest", id: "guest-7", label: "Sam" },
      text: "@Viktor please check this",
      attachments: [],
      mentions: [{ startUtf16: 0, lengthUtf16: 7, principal: { kind: "user", id: "user-42", label: "Viktor" } }],
    }],
  }));
  assert.match(context.withParticipantContext("invoke agent", claim), /untrusted participant context/);
  assert.ok(context.withParticipantContext("invoke agent", claim).endsWith("\n\ninvoke agent"));
});

test("preserves normalized attachments in transcript storage and provider delivery", async () => {
  const sessionId = "context-attachment";
  const attachment = { path: "/tmp/plan.md", originalName: "plan.md", filename: "plan.md", size: 12, mimetype: "text/markdown" };
  const { event } = await context.appendContextMessage(sessionId, command("18"), {
    text: "review the attachment", author: alice, attachments: [attachment], mentions: [],
  });
  assert.deepEqual(event.attachments, [attachment]);
  const delivered = JSON.parse(context.claimContext(sessionId, "attachment-turn")!.envelope);
  assert.deepEqual(delivered.messages[0].attachments, [attachment]);
});

test("branch state treats inherited participant context as already delivered", async () => {
  const source = "branch-source";
  const target = "branch-target";
  const { event } = await context.appendContextMessage(source, command("16"), input("history"));
  context.initializeBranchedContext(target, [{ id: event.eventId, event }]);
  assert.equal(context.claimContext(target, "branch-turn"), null);
  const next = await context.appendContextMessage(target, command("17"), input("new branch context"));
  assert.equal(next.event.contextSeq, 2);
});

test("rejects a sixty-fifth pending message without truncating the backlog", async () => {
  const sessionId = "backlog-bound";
  for (let index = 0; index < 64; index += 1) {
    await context.appendContextMessage(sessionId, command(String(20 + index).padStart(2, "0")), input(`m${index}`));
  }
  await assert.rejects(
    context.appendContextMessage(sessionId, "018f06c2-1c2a-7b35-8f2d-6f2f9024ad00", input("overflow")),
    (error: unknown) => (error as { code?: string }).code === "CONTEXT_BACKLOG_FULL",
  );
  assert.equal(JSON.parse(context.claimContext(sessionId, "bounded-turn")!.envelope).messages.length, 64);
});
