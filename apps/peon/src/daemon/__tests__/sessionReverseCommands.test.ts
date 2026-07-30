import assert from "node:assert/strict";
import test from "node:test";
import type { SessionJsonService, SessionRecord } from "../sessions/index.js";
import { sessionCommandHandlers } from "../overseer/socket/channels/sessionCommandHandlers.js";
import type { ValidCommand } from "../overseer/socket/channels/reverseCommandChannel.js";

const PEON = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION, prompt: "first", title: null, followUpPrompts: [], queuedFollowUps: [],
    pendingSystemPrompts: [], dir: "/tmp", agent: "claude-code", backendSessionId: SESSION,
    backendTurnId: null, backendRuntimeGeneration: null, backendTurnStatus: null, model: null,
    reasoningEffort: null, projectId: null, projectKey: null, candidateProjectKeys: [],
    taskKey: null, taskTitle: null, initiator: "owner@example.com", parentSessionId: null,
    spawnDepth: 0, spawnRequestId: null, parentCompletionNotifiedAt: null,
    parentCompletionNotificationPending: false, expectsOutcome: false, status: "completed",
    outcome: null, startedAt: 1, endedAt: 2, turnCount: 1, turnBudget: 1, usage: null,
    usageByModel: {}, contextUsage: null, autoResumeAttempts: 0, lastActivityAt: 2,
    lastUserMessageAt: 1, lastMessagePreview: null, eventCount: 0, ...overrides,
  };
}

function harness() {
  let current: SessionRecord | undefined = record();
  let starts = 0;
  let resumes = 0;
  const service = {
    get: () => current,
    list: () => current ? [current] : [],
    page: () => ({ sessions: [], nextCursor: null, hasMore: false }),
    start: (options) => {
      starts += 1;
      current = record({ id: options.id ?? SESSION, prompt: options.prompt, initiator: options.author ?? null, status: "running" });
      return current;
    },
    resume: (_id, prompt, _attachments, _permission, author, _model, _effort, commandId) => {
      resumes += 1;
      current!.followUpPrompts.push(prompt);
      current!.initiator = author ?? null;
      current!.lastMessagePreview = commandId ?? null;
      return current!;
    },
    rename: (_id, title) => current ? (current.title = title, current) : undefined,
    cancel: () => true,
    delete: () => current ? (current = undefined, "deleted" as const) : "not_found" as const,
    queued: () => current?.queuedFollowUps.slice(),
    enqueue: (_id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId) => {
      current!.queuedFollowUps.push({
        id: ITEM, sessionId: SESSION, prompt, attachments: attachments ?? [],
        permissionMode: permissionMode ?? null, author: author ?? null, model: model ?? null,
        reasoningEffort: reasoningEffort ?? null, commandId: commandId ?? null, queuedAt: 3,
      });
      return current!;
    },
    editQueued: (_id, itemId, prompt) => {
      const item = current?.queuedFollowUps.find((candidate) => candidate.id === itemId);
      if (!current) return "unknown_session" as const;
      if (!item) return "not_found" as const;
      item.prompt = prompt;
      return current;
    },
    sendQueuedNow: (_id, itemId) => current?.queuedFollowUps.some((item) => item.id === itemId) ? "sent" as const : "not_found" as const,
    removeQueued: (_id, itemId) => {
      if (!current) return "unknown_session" as const;
      const index = current.queuedFollowUps.findIndex((item) => item.id === itemId);
      if (index < 0) return "not_found" as const;
      current.queuedFollowUps.splice(index, 1);
      return "removed" as const;
    },
  } as unknown as SessionJsonService;
  return { service, counts: () => ({ starts, resumes }), current: () => current };
}

function command(operation: string, payload: Record<string, unknown> = {}, sessionId: string | undefined = SESSION): ValidCommand {
  return {
    commandId: "55555555-5555-4555-8555-555555555555", operation,
    target: { peonId: PEON, ...(sessionId ? { sessionId } : {}) },
    actor: { userId: USER, email: "trusted@example.com" },
    payload, expected: null, requestedAt: 1,
  };
}

test("session handlers preserve canonical actor and command identity on follow-up and queue add", async () => {
  const state = harness();
  const handlers = sessionCommandHandlers(state.service);
  const followup = command("session.followup", { prompt: "next" });
  assert.equal(handlers[followup.operation]!.validate(followup.payload, null, followup), null);
  assert.equal((await handlers[followup.operation]!.execute(followup)).code, "OK");
  assert.equal(state.current()!.initiator, "trusted@example.com");
  assert.equal(state.current()!.lastMessagePreview, followup.commandId);

  const queued = command("session.queue.add", { prompt: "later" });
  assert.equal((await handlers[queued.operation]!.execute(queued)).code, "OK");
  assert.equal(state.current()!.queuedFollowUps[0]!.author, "trusted@example.com");
  assert.equal(state.current()!.queuedFollowUps[0]!.commandId, queued.commandId);
});

test("queue conflicts are session scoped and deterministic", async () => {
  const state = harness();
  const handlers = sessionCommandHandlers(state.service);
  const missing = command("session.queue.remove", { itemId: ITEM });
  assert.deepEqual(await handlers[missing.operation]!.execute(missing), { status: "rejected", code: "UNKNOWN_QUEUE_ITEM" });
  await handlers["session.queue.add"]!.execute(command("session.queue.add", { prompt: "later" }));
  assert.equal((await handlers["session.queue.send-now"]!.execute(command("session.queue.send-now", { itemId: ITEM }))).code, "OK");
  assert.equal((await handlers["session.queue.remove"]!.execute(command("session.queue.remove", { itemId: ITEM }))).code, "OK");
});

test("delete replay shape is an idempotent noop and private fields never enter public results", async () => {
  const state = harness();
  const handlers = sessionCommandHandlers(state.service);
  const deletion = command("session.delete");
  assert.deepEqual(await handlers[deletion.operation]!.execute(deletion), {
    status: "applied", code: "OK", result: { sessionId: SESSION, deleted: true },
  });
  assert.deepEqual(await handlers[deletion.operation]!.execute(deletion), {
    status: "noop", code: "OK", result: { sessionId: SESSION, deleted: true },
  });
});

test("payload bounds and cross-session queue ids are rejected before effects", async () => {
  const state = harness();
  const handlers = sessionCommandHandlers(state.service);
  const oversized = command("session.followup", { prompt: "x".repeat(33 * 1024) });
  assert.notEqual(handlers[oversized.operation]!.validate(oversized.payload, null, oversized), null);
  const malformed = command("session.queue.edit", { itemId: "../other", prompt: "x" });
  assert.notEqual(handlers[malformed.operation]!.validate(malformed.payload, null, malformed), null);
  assert.deepEqual(state.counts(), { starts: 0, resumes: 0 });
});
