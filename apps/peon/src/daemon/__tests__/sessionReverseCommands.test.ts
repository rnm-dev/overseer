import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionJsonService, SessionRecord } from "../sessions/index.js";
import {
  sessionCommandHandlers,
  validSessionCommandExecution,
} from "../overseer/socket/channels/sessionCommandHandlers.js";
import {
  ReverseCommandChannel,
  type ValidCommand,
} from "../overseer/socket/channels/reverseCommandChannel.js";
import { ReverseCommandLedger } from "../overseer/socket/reverseCommandLedger.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

const PEON = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";
const SESSION_OPERATIONS = [
  "session.start", "session.followup", "session.queue.list", "session.queue.add",
  "session.queue.edit", "session.queue.remove", "session.queue.send-now",
  "session.metadata.patch", "session.cancel", "session.delete",
];

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
  const queueStartNow: boolean[] = [];
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
    enqueue: (_id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId, startNow) => {
      queueStartNow.push(startNow === true);
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
  return { service, counts: () => ({ starts, resumes }), queueStartNow, current: () => current };
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

test("queue add applies startNow atomically and returns bounded canonical session state", async () => {
  const state = harness();
  const handlers = sessionCommandHandlers(state.service);
  const deferred = command("session.queue.add", { prompt: "later", startNow: false });
  const immediate = command("session.queue.add", { prompt: "now", startNow: true });
  const first = await handlers[deferred.operation]!.execute(deferred);
  const second = await handlers[immediate.operation]!.execute(immediate);
  assert.deepEqual(state.queueStartNow, [false, true]);
  for (const result of [first, second]) {
    assert.equal(result.code, "OK");
    assert.equal(result.result?.sessionId, SESSION);
    assert.equal((result.result?.session as PeonSocketFrame).id, SESSION);
    assert.equal(Object.hasOwn(result.result?.session as object, "pendingSystemPrompts"), false);
    assert.equal(validSessionCommandExecution(deferred, result), true);
  }
  const invalid = command("session.queue.add", { prompt: "later", startNow: "yes" });
  assert.notEqual(handlers[invalid.operation]!.validate(invalid.payload, null, invalid), null);
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
  const actorSuppliedId = command("session.followup", { prompt: "x", commandId: ITEM });
  assert.notEqual(handlers[actorSuppliedId.operation]!.validate(actorSuppliedId.payload, null, actorSuppliedId), null);
  assert.deepEqual(state.counts(), { starts: 0, resumes: 0 });
});

test("session result allowlists fail closed on cross-session and private state", () => {
  const followup = command("session.followup", { prompt: "next" });
  const {
    pendingSystemPrompts: _pending,
    parentCompletionNotifiedAt: _notified,
    parentCompletionNotificationPending: _notificationPending,
    ...publicRecord
  } = record();
  assert.equal(validSessionCommandExecution(followup, {
    status: "applied", code: "OK", result: publicRecord,
  }), true);
  assert.equal(validSessionCommandExecution(followup, {
    status: "applied", code: "OK", result: record(),
  }), false);
  const safe = record();
  delete (safe as Partial<SessionRecord>).pendingSystemPrompts;
  assert.equal(validSessionCommandExecution(followup, {
    status: "applied", code: "OK", result: safe,
  }), false, "other private lifecycle fields remain forbidden");
  assert.equal(validSessionCommandExecution(command("session.delete"), {
    status: "noop", code: "OK", result: { sessionId: SESSION, deleted: true, extra: "leak" },
  }), false);
  assert.equal(validSessionCommandExecution(command("session.queue.remove", { itemId: ITEM }), {
    status: "applied", code: "OK", result: { sessionId: "66666666-6666-4666-8666-666666666666", itemId: ITEM },
  }), false);
});

test("attachment resolution canonicalizes contained files and rejects escaping symlinks", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-session-attachments-"));
  const root = path.join(directory, "root");
  const outside = path.join(directory, "outside.txt");
  mkdirSync(root);
  writeFileSync(outside, "secret");
  symlinkSync(outside, path.join(root, "escape.txt"));
  const state = harness();
  const handlers = sessionCommandHandlers(state.service, { fileTransferRoot: () => root });
  const attachment = {
    originalName: "escape.txt", filename: "escape.txt", path: path.join(root, "escape.txt"),
    size: 6, mimetype: "text/plain",
  };
  try {
    assert.deepEqual(await handlers["session.followup"]!.execute(command("session.followup", {
      prompt: "read this", attachments: [attachment],
    })), { status: "rejected", code: "PATH_ESCAPE" });
    assert.equal(state.counts().resumes, 0);
    const inside = path.join(root, "inside.txt");
    writeFileSync(inside, "safe");
    const applied = await handlers["session.followup"]!.execute(command("session.followup", {
      prompt: "read this", attachments: [{ ...attachment, path: inside, size: 4 }],
    }));
    assert.equal(applied.code, "OK");
    assert.equal(state.counts().resumes, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid session targets are rejected before durable admission", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-session-targets-"));
  const ledger = new ReverseCommandLedger({ fileBase: path.join(directory, "ledger") });
  const sent: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: true, authority: "authority", generation: 7,
    send: (frame) => { sent.push(frame); return true; },
    sendBinary: () => false,
    sendDurable: () => ({ accepted: true, epoch: "epoch", cursor: "cursor", messageId: ITEM }),
    disconnect: (reason) => assert.fail(reason),
  };
  const handlers = sessionCommandHandlers(harness().service);
  const channel = new ReverseCommandChannel({ peonId: () => PEON, ledger, handlers });
  channel.started(sender);
  channel.negotiated(true, {}, sender);
  const envelope = (operation: string, target: PeonSocketFrame): PeonSocketFrame => ({
    type: "command", protocol: 1, capability: "reverse-command-v1",
    commandId: "77777777-7777-4777-8777-777777777777", operation, target,
    actor: { userId: USER, email: "trusted@example.com" },
    payload: operation === "session.start" ? { prompt: "new" } : { prompt: "next" },
    expected: null, requestedAt: 1,
  });
  try {
    channel.receive(envelope("session.start", { peonId: PEON, sessionId: SESSION }), sender);
    channel.receive(envelope("session.followup", { peonId: PEON }), sender);
    assert.equal(ledger.records().length, 0);
    assert.equal(sent.filter((frame) => frame.code === "BAD_COMMAND").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normative schema publishes strict payload contracts for every session operation", () => {
  const schema = JSON.parse(readFileSync(
    path.resolve(import.meta.dirname, "../../../protocol/reverse-command-v1/schema.json"),
    "utf8",
  ));
  const operations = schema.$defs.command.properties.operation.enum as string[];
  assert.ok(SESSION_OPERATIONS.every((operation) => operations.includes(operation)));
  for (const name of [
    "sessionTurnPayload", "sessionStartPayload", "sessionQueueAddPayload", "sessionQueueItemPayload",
    "sessionQueueEditPayload", "sessionMetadataPayload", "sessionAttachment",
  ]) {
    assert.equal(schema.$defs[name].additionalProperties, false, name);
  }
  assert.equal(schema.$defs.command.allOf.length, 8);
});

test("replayed startNow queue add executes once across channel restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "peon-session-start-now-replay-"));
  const fileBase = path.join(directory, "ledger");
  const state = harness();
  const durable: PeonSocketFrame[] = [];
  const sent: PeonSocketFrame[] = [];
  const sender: PeonSocketSender = {
    durable: true, authority: "authority", generation: 1,
    send: (message) => { sent.push(message); return true; }, sendBinary: () => false,
    sendDurable: (frame) => {
      durable.push(frame);
      return { accepted: true, epoch: "epoch", cursor: ITEM, messageId: ITEM };
    },
    disconnect: (reason) => assert.fail(reason),
  };
  const frame: PeonSocketFrame = {
    type: "command", protocol: 1, capability: "reverse-command-v1",
    commandId: "88888888-8888-4888-8888-888888888888",
    operation: "session.queue.add", target: { peonId: PEON, sessionId: SESSION },
    actor: { userId: USER, email: "trusted@example.com" },
    payload: { prompt: "now", startNow: true }, expected: null, requestedAt: 1,
  };
  try {
    const first = new ReverseCommandChannel({
      peonId: () => PEON,
      ledger: new ReverseCommandLedger({ fileBase }),
      handlers: sessionCommandHandlers(state.service),
    });
    first.started(sender);
    first.negotiated(true, {}, sender);
    first.receive(frame, sender);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restarted = new ReverseCommandChannel({
      peonId: () => PEON,
      ledger: new ReverseCommandLedger({ fileBase }),
      handlers: sessionCommandHandlers(state.service),
    });
    restarted.started(sender);
    restarted.negotiated(true, {}, sender);
    restarted.receive(frame, sender);
    restarted.receive({ ...frame, payload: { prompt: "now", startNow: false } }, sender);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(state.queueStartNow, [true]);
    assert.equal(state.current()!.queuedFollowUps.length, 1);
    assert.ok(durable.length >= 1);
    assert.ok(sent.some((message) => message.code === "COMMAND_ID_REUSED"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
