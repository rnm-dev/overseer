import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Server } from "node:http";
import express from "express";
import test from "node:test";

import { type SessionRecord, type QueuedFollowUp } from "../sessions/index.js";
import { type HumanSessionService, createHumanSessionsRouter } from "../http/human/sessions.js";

type DeleteResult = "deleted" | "not_found" | "running";

interface TestFixture {
  list: number;
  page: number;
  get: number;
  start: number;
  rename: number;
  delete: number;
  resume: number;
  enqueue: number;
  queued: number;
  editQueued: number;
  sendQueuedNow: number;
  removeQueued: number;
  cancel: number;
  toSessionSummary: number;
  toPublicSessionRecord: number;
  toSessionView: number;
}

const COMPLETE_SESSION = "7e3af8f5-8f2d-4f3f-9d9d-2f4c0f4c1f33";
const QUEUE_SESSION = "9f8cfb3b-16cb-47e3-81a2-bc4f9a7d4a66";

function makeRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    prompt: "initial prompt",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: "/tmp",
    agent: "claude-code",
    backendSessionId: "backend-session",
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: null,
    model: null,
    reasoningEffort: null,
    projectId: null,
    projectKey: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    parentSessionId: null,
    spawnDepth: 0,
    spawnRequestId: null,
    parentCompletionNotifiedAt: null,
    parentCompletionNotificationPending: false,
    expectsOutcome: false,
    status: "running",
    outcome: null,
    startedAt: 100,
    endedAt: null,
    turnCount: 0,
    turnBudget: 0,
    usage: null,
    usageByModel: {},
    contextUsage: null,
    autoResumeAttempts: 0,
    lastActivityAt: 100,
    lastUserMessageAt: 100,
    lastMessagePreview: null,
    eventCount: 0,
    ...overrides,
  };
}

const callLog: TestFixture = {
  list: 0,
  page: 0,
  get: 0,
  start: 0,
  rename: 0,
  delete: 0,
  resume: 0,
  enqueue: 0,
  queued: 0,
  editQueued: 0,
  sendQueuedNow: 0,
  removeQueued: 0,
  cancel: 0,
  toSessionSummary: 0,
  toPublicSessionRecord: 0,
  toSessionView: 0,
};

const records = new Map<string, SessionRecord>();
let lastStartArgs: Parameters<HumanSessionService["start"]>[0] | null = null;

const service: HumanSessionService = {
  start: (options) => {
    callLog.start += 1;
    lastStartArgs = options;
    const record = makeRecord({ id: options.id ?? randomUUID(), prompt: options.prompt, status: "running", initiator: options.author ?? null });
    records.set(record.id, record);
    return record;
  },
  list: () => {
    callLog.list += 1;
    return [...records.values()];
  },
  page: ({ limit, cursor }) => {
    callLog.page += 1;
    const sessions = [...records.values()].slice(0, limit);
    const nextCursor = sessions.length < records.size ? String(records.size) : null;
    void cursor;
    return { sessions, nextCursor: nextCursor as string | null };
  },
  get: (id) => {
    callLog.get += 1;
    return records.get(id);
  },
  rename: (id, title) => {
    callLog.rename += 1;
    const record = records.get(id);
    if (!record) return undefined;
    record.title = title?.trim() || null;
    return record;
  },
  delete: (id): DeleteResult => {
    callLog.delete += 1;
    const record = records.get(id);
    if (!record) return "not_found";
    if (record.status === "running") return "running";
    records.delete(id);
    return "deleted";
  },
  resume: () => {
    callLog.resume += 1;
    throw new Error("resume not under test");
  },
  enqueue: (id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId) => {
    callLog.enqueue += 1;
    const record = records.get(id);
    if (!record) throw new Error("unknown session");
    const queued: QueuedFollowUp = {
      id: randomUUID(),
      sessionId: id,
      prompt,
      attachments: attachments ?? [],
      permissionMode: permissionMode ?? null,
      author: author ?? null,
      model: model ?? null,
      reasoningEffort: reasoningEffort ?? null,
      commandId: commandId ?? null,
      queuedAt: 100,
    };
    record.queuedFollowUps.push(queued);
    return record;
  },
  queued: (id) => {
    callLog.queued += 1;
    return records.get(id)?.queuedFollowUps.slice();
  },
  editQueued: (id, itemId, prompt) => {
    callLog.editQueued += 1;
    const record = records.get(id);
    if (!record) return "unknown_session";
    const item = record.queuedFollowUps.find((queued) => queued.id === itemId);
    if (!item) return "not_found";
    item.prompt = prompt;
    return record;
  },
  sendQueuedNow: (id, itemId) => {
    callLog.sendQueuedNow += 1;
    const record = records.get(id);
    if (!record) return "unknown_session";
    const index = record.queuedFollowUps.findIndex((item) => item.id === itemId);
    if (index === -1) return "not_found";
    const [item] = record.queuedFollowUps.splice(index, 1);
    record.queuedFollowUps.unshift(item);
    return "sent";
  },
  removeQueued: (id, itemId) => {
    callLog.removeQueued += 1;
    const record = records.get(id);
    if (!record) return "unknown_session";
    const index = record.queuedFollowUps.findIndex((item) => item.id === itemId);
    if (index === -1) return "not_found";
    record.queuedFollowUps.splice(index, 1);
    return "removed";
  },
  cancel: (id) => {
    callLog.cancel += 1;
    return records.get(id)?.status === "running" || records.get(id)?.status === "completed";
  },
};

function resetFixtures() {
  records.clear();
  callLog.list = 0;
  callLog.page = 0;
  callLog.get = 0;
  callLog.start = 0;
  callLog.rename = 0;
  callLog.delete = 0;
  callLog.resume = 0;
  callLog.enqueue = 0;
  callLog.queued = 0;
  callLog.editQueued = 0;
  callLog.sendQueuedNow = 0;
  callLog.removeQueued = 0;
  callLog.cancel = 0;
  callLog.toSessionSummary = 0;
  callLog.toPublicSessionRecord = 0;
  callLog.toSessionView = 0;
  lastStartArgs = null;

  records.set(COMPLETE_SESSION, makeRecord({ id: COMPLETE_SESSION, status: "completed", title: "complete" }));
  records.set(QUEUE_SESSION, makeRecord({ id: QUEUE_SESSION, status: "completed", projectKey: "human", title: "queue" }));
}

const app = express();
app.use(express.json());
app.use("/api/v1", createHumanSessionsRouter({
  sessionService: service,
  helpers: {
    toSessionSummary: (record) => {
      callLog.toSessionSummary += 1;
      return {
        id: record.id,
        status: record.status,
        projectKey: record.projectKey,
        projectId: record.projectId,
        title: record.title,
        promptPreview: record.title || record.prompt,
        lastMessagePreview: record.lastMessagePreview,
        initiator: record.initiator,
        outcome: record.outcome,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        lastActivityAt: record.lastActivityAt,
      };
    },
    toPublicSessionRecord: (record) => {
      callLog.toPublicSessionRecord += 1;
      return {
        id: record.id,
        status: record.status,
        title: record.title,
      };
    },
    toSessionView: (record) => {
      callLog.toSessionView += 1;
      return {
        ...record,
        viewers: ["human-viewer"],
        viewerCount: 1,
      };
    },
    resolveSessionAuthor: () => "human@example.com",
    resolveSessionViewer: () => "human-viewer",
    resolveDefaultAgent: () => "claude-code",
    listAgentsForNewSessionError: () => "claude-code, codex",
    narrowNewSessionAgent: (value) => (typeof value === "string" ? value : undefined),
    narrowModel: (value, _agent) => (typeof value === "string" ? value : undefined),
    narrowReasoningEffort: (value, _agent) => (typeof value === "string" ? value : undefined),
  },
  resolveSessionId: () => randomUUID(),
}));

const server: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1`;

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("human sessions collection route uses injected list service and summary helper", async () => {
  resetFixtures();

  const response = await fetch(`${base}/sessions`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { sessions: Array<{ id: string }> };
  assert.equal(payload.sessions.length, 2);
  assert.equal(payload.sessions[0]?.id, COMPLETE_SESSION);
  assert.equal(callLog.list, 1);
  assert.equal(callLog.toSessionSummary, 2);
});

test("human session detail returns session view and uses viewer helper", async () => {
  resetFixtures();

  const response = await fetch(`${base}/sessions/${COMPLETE_SESSION}`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { id: string; viewerCount: number };
  assert.equal(payload.id, COMPLETE_SESSION);
  assert.equal(payload.viewerCount, 1);
  assert.equal(callLog.get, 1);
  assert.equal(callLog.toSessionView, 1);
});

test("human session creation maps request and service result through helpers", async () => {
  resetFixtures();

  const response = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "plan a migration",
      dir: "/tmp",
      projectKey: "human",
      expectsOutcome: true,
      model: "sonnet",
    }),
  });
  assert.equal(response.status, 201);
  const payload = (await response.json()) as { id: string; title: string | null; status: string };
  assert.equal(payload.title, null);
  assert.equal(payload.status, "running");
  assert.ok(lastStartArgs !== null);
  assert.equal(lastStartArgs.expectsOutcome, true);
  assert.equal(lastStartArgs.projectKey, "human");
  assert.equal(lastStartArgs.model, "sonnet");
  assert.equal(callLog.start, 1);
  assert.equal(callLog.toPublicSessionRecord, 1);
});

test("human session rename and delete delegate to service contracts", async () => {
  resetFixtures();

  const rename = await fetch(`${base}/sessions/${COMPLETE_SESSION}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "new title" }),
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json() as { title: string | null }).title, "new title");
  assert.equal(callLog.rename, 1);

  records.get(COMPLETE_SESSION)!.status = "completed";
  const deleted = await fetch(`${base}/sessions/${COMPLETE_SESSION}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal(callLog.delete, 1);
});

test("human session queue and cancel routes keep human envelopes", async () => {
  resetFixtures();
  records.get(QUEUE_SESSION)!.status = "completed";

  const queue = await fetch(`${base}/sessions/${QUEUE_SESSION}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "queued follow-up" }),
  });
  assert.equal(queue.status, 201);
  const queued = (await queue.json()) as { status: string };
  assert.equal(queued.status, "completed");
  assert.equal(callLog.enqueue, 1);

  const queueError = await fetch(`${base}/sessions/${QUEUE_SESSION}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "   " }),
  });
  assert.equal(queueError.status, 400);
  assert.deepEqual(await queueError.json(), { error: "prompt is required" });

  const cancel = await fetch(`${base}/sessions/${COMPLETE_SESSION}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { ok: true });
  assert.equal(callLog.cancel, 1);
});
