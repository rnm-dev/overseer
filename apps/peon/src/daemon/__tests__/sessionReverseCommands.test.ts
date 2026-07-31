import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SessionJsonService, SessionRecord } from "../sessions/index.js";
import {
  sessionCommandHandlers,
  validSessionCommandExecution,
} from "../overseer/socket/channels/sessionCommandHandlers.js";
import type { ValidCommand } from "../overseer/socket/channels/reverseCommandChannel.js";

const PEON = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";

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

function command(operation: string, payload: Record<string, unknown> = {}): ValidCommand {
  return {
    commandId: "55555555-5555-4555-8555-555555555555", operation,
    target: { peonId: PEON, sessionId: SESSION },
    actor: { userId: USER, email: "trusted@example.com" },
    payload, expected: null, requestedAt: 1,
  };
}

test("remaining session handlers preserve bounded public results and delete replay", async () => {
  let current: SessionRecord | undefined = record();
  const service = {
    get: () => current,
    rename: (_id: string, title: string | null) => current ? (current.title = title, current) : undefined,
    delete: () => current ? (current = undefined, "deleted" as const) : "not_found" as const,
  } as unknown as SessionJsonService;
  const handlers = sessionCommandHandlers(service);
  const metadata = command("session.metadata.patch", { title: "renamed" });
  const renamed = await handlers[metadata.operation]!.execute(metadata);
  assert.equal(validSessionCommandExecution(metadata, renamed), true);
  assert.equal(Object.hasOwn(renamed.result as object, "pendingSystemPrompts"), false);
  const deletion = command("session.delete");
  assert.deepEqual(await handlers[deletion.operation]!.execute(deletion), {
    status: "applied", code: "OK", result: { sessionId: SESSION, deleted: true },
  });
  assert.deepEqual(await handlers[deletion.operation]!.execute(deletion), {
    status: "noop", code: "OK", result: { sessionId: SESSION, deleted: true },
  });
});

test("all queue operations are absent from the Peon reverse contract", () => {
  const schema = JSON.parse(readFileSync(
    path.resolve(import.meta.dirname, "../../../protocol/reverse-command-v1/schema.json"),
    "utf8",
  ));
  const operations = schema.$defs.command.properties.operation.enum as string[];
  for (const operation of [
    "session.queue.add", "session.queue.list", "session.queue.edit",
    "session.queue.remove", "session.queue.send-now",
  ]) {
    assert.equal(operations.includes(operation), false, operation);
    assert.equal(Object.hasOwn(sessionCommandHandlers({} as SessionJsonService), operation), false, operation);
  }
  assert.ok(operations.includes("session.metadata.patch"));
  assert.ok(operations.includes("session.delete"));
  assert.equal(schema.$defs.sessionQueueAddPayload, undefined);
  assert.equal(schema.$defs.sessionQueueEditPayload, undefined);
  assert.equal(schema.$defs.sessionQueueItemPayload, undefined);
});
