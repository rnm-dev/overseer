import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-session-routes-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-session-routes-state-"));

const { createAgentRouter } = await import("../agentApi.js");
const { settings } = await import("../settings/index.js");
import { INCLUDED_FLEET_SESSION_ROUTES, type FleetSessionService } from "../http/fleet/sessions.js";
import type { SessionRecord } from "../sessions/index.js";

settings.update({ overseerToken: "pn_session_routes_test", paused: false });

const token = "pn_session_routes_test";
const headers = {
  Authorization: `Bearer ${token}`,
};

function makeRecord(id: string): SessionRecord {
  return {
    id,
    prompt: "prompt",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: "/tmp",
    agent: "claude-code",
    backendSessionId: null,
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: "completed",
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
    expectsOutcome: false,
    status: "completed",
    outcome: null,
    startedAt: 1,
    endedAt: 2,
    turnCount: 1,
    turnBudget: 1,
    usage: null,
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: 1,
    lastUserMessageAt: 1,
    lastMessagePreview: null,
    eventCount: 0,
  };
}

type SessionPage = { sessions: SessionRecord[]; hasMore: boolean; nextCursor: string | null };

function createHarness() {
  const records = new Map<string, SessionRecord>();
  const calls = {
    list: 0,
    page: 0,
    get: 0,
    rename: 0,
    start: 0,
    resume: 0,
    appendContextMessage: 0,
    enqueue: 0,
    queued: 0,
    editQueued: 0,
    sendQueuedNow: 0,
    removeQueued: 0,
    cancel: 0,
    delete: 0,
    startArgs: [] as Array<{
      permissionMode: string | undefined;
      model: string | undefined;
      reasoningEffort: string | undefined;
      id: string | undefined;
      author: string | undefined;
      commandId: string | undefined;
    }>,
    queueArgs: [] as Array<{
      id: string;
      author: string | undefined;
      commandId: string | undefined;
    }>,
    cancelArgs: [] as string[],
  };
  const sessionService: FleetSessionService = {
    list: () => {
      calls.list++;
      return Array.from(records.values());
    },
    page: (pageOptions) => {
      calls.page++;
      const list = Array.from(records.values());
      return {
        sessions: list.slice(0, pageOptions.limit),
        hasMore: false,
        nextCursor: null,
      };
    },
    get: (id) => {
      calls.get++;
      return records.get(id);
    },
    rename: (id, title) => {
      calls.rename++;
      const existing = records.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, title: title };
      records.set(id, updated);
      return updated;
    },
    start: (opts) => {
      calls.start++;
      calls.startArgs.push({
        permissionMode: opts.permissionMode,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        id: opts.id,
        author: opts.author,
        commandId: opts.commandId,
      });
      const id = opts.id ?? randomUUID();
      const record: SessionRecord = {
        ...makeRecord(id),
        prompt: opts.prompt,
        dir: opts.dir ?? "/tmp",
        initiator: opts.author ?? null,
        parentCompletionNotificationPending: false,
      };
      records.set(id, record);
      return record;
    },
    resume: (_id, _prompt, _attachments, permissionMode, author, _model, reasoningEffort, commandId) => {
      calls.resume++;
      return records.get(_id) ?? makeRecord(_id);
    },
    appendContextMessage: async (commandId, id, input) => {
      calls.appendContextMessage++;
      return {
        type: "participant_message",
        eventId: "participant_1",
        commandId,
        contextSeq: 1,
        createdAt: 10,
        ...input,
      };
    },
    replayContextMessage: () => null,
    enqueue: (_id, _prompt, _attachments, permissionMode, author, _model, reasoningEffort, commandId, _startNow) => {
      calls.enqueue++;
      calls.queueArgs.push({ id: _id, author, commandId });
      const record = records.get(_id);
      if (!record) return makeRecord(_id);
      return {
        ...record,
        followUpPrompts: [...record.followUpPrompts, _prompt],
      };
    },
    queued: (_id) => {
      calls.queued++;
      const record = records.get(_id);
      return record ? record.queuedFollowUps : undefined;
    },
    editQueued: (_id, _itemId, _prompt) => {
      calls.editQueued++;
      return records.get(_id);
    },
    sendQueuedNow: (_id, _itemId) => {
      calls.sendQueuedNow++;
      return records.get(_id) ? "sent" : "unknown_session";
    },
    removeQueued: (_id, _itemId) => {
      calls.removeQueued++;
      return records.get(_id) ? "removed" : "unknown_session";
    },
    cancel: (id) => {
      calls.cancel++;
      calls.cancelArgs.push(id);
      return records.get(id)?.status === "running";
    },
    delete: (id) => {
      calls.delete++;
      return records.delete(id) ? "deleted" : "not_found";
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createAgentRouter({ sessionService, getFileTransferRoot: () => "/tmp", defaultAgent: "claude-code" }));

  const api: Server = app.listen(0, "127.0.0.1");
  const apiAddressPromise = new Promise<string>((resolve, reject) => {
    api.once("listening", () => {
      const apiAddress = api.address();
      if (!apiAddress || typeof apiAddress === "string") {
        reject(new Error("expected socket address"));
        return;
      }
      resolve(`http://127.0.0.1:${apiAddress.port}/api/v1`);
    });
    api.once("error", reject);
  });
  return {
    close: async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
    },
    calls,
    records,
    sessionService,
    base: apiAddressPromise,
  };
}

test("route inventory includes expected session JSON families", () => {
  assert.equal(INCLUDED_FLEET_SESSION_ROUTES.length, 15);
});

test("context-only route requires idempotency and relays normalized principals without invoking an agent", async () => {
  const harness = createHarness();
  const base = await harness.base;
  harness.records.set("shared", makeRecord("shared"));
  const requestId = randomUUID();
  const response = await fetch(`${base}/sessions/shared/context-messages`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Peon-Request-Id": requestId },
    body: JSON.stringify({ text: "hello Bob", author: { kind: "user", id: "alice", label: "Alice" }, mentions: [] }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { commandId: string }).commandId, requestId);
  assert.equal(harness.calls.appendContextMessage, 1);
  assert.equal(harness.calls.resume, 0);
  assert.equal(harness.calls.enqueue, 0);

  const missingId = await fetch(`${base}/sessions/shared/context-messages`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello", author: { kind: "user", id: "alice", label: "Alice" } }),
  });
  assert.equal(missingId.status, 400);
  assert.equal((await missingId.json() as { code: string }).code, "BAD_CONTEXT_MESSAGE");
  await harness.close();
});

test("list sessions with pagination delegates to session service", async () => {
  const harness = createHarness();
  const base = await harness.base;

  const initial = makeRecord("session-a");
  harness.records.set("session-a", initial);

  const response = await fetch(`${base}/sessions?limit=1`, { headers: { ...headers } });
  assert.equal(response.status, 200);
  const payload = await response.json() as { sessions: Array<{ id: string }> };

  assert.equal(harness.calls.page, 1);
  assert.equal(payload.sessions[0]?.id, "session-a");

  await harness.close();
});

test("create session forwards actor and peon-request-id into service arguments", async () => {
  const harness = createHarness();
  const base = await harness.base;

  const requestId = randomUUID();
  const response = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Peon-Actor": "alice@example.com", "Peon-Request-Id": requestId },
    body: JSON.stringify({ prompt: "hello", dir: "/tmp/workspace", expectsOutcome: true }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("Peon-Request-Id"), requestId);

  assert.equal(harness.calls.start, 1);
  assert.equal(harness.calls.startArgs.at(0)?.author, "alice@example.com");
  assert.equal(harness.calls.startArgs.at(0)?.id, requestId);

  await harness.close();
});

test("queue mutation endpoint uses injected service and author attribution", async () => {
  const harness = createHarness();
  const base = await harness.base;
  harness.records.set("active-session", makeRecord("active-session"));

  const response = await fetch(`${base}/sessions/active-session/queue`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Peon-Actor": "queue-worker" },
    body: JSON.stringify({ prompt: "next step", startNow: false }),
  });
  assert.equal(response.status, 201);
  assert.equal(harness.calls.enqueue, 1);
  assert.equal(harness.calls.queueArgs.at(0)?.author, "queue-worker");

  await harness.close();
});

test("cancel returns queueing-aware contract error when session is not running", async () => {
  const harness = createHarness();
  const base = await harness.base;
  harness.records.set("inactive", makeRecord("inactive"));

  const response = await fetch(`${base}/sessions/inactive/cancel`, { method: "POST", headers });
  assert.equal(response.status, 409);
  const payload = await response.json() as { code: string };
  assert.equal(payload.code, "SESSION_NOT_RUNNING");
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.cancelArgs.at(0), "inactive");

  await harness.close();
});
