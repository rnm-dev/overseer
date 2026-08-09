import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { CodingAgent, ReasoningEffort } from "../providers/modelCatalog.js";
import {
  SessionOrchestrationService,
  SessionSpawnError,
  type SessionOrchestrationStore,
  type SessionSpawnOptions,
} from "../sessions/orchestration.js";
import type { SessionRecord } from "../sessions/sessionTypes.js";
import { TranscriptPaginationError, type TranscriptPage } from "../sessions/transcriptPagination.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "parent",
    prompt: "parent task",
    title: null,
    followUpPrompts: [],
    queuedFollowUps: [],
    pendingSystemPrompts: [],
    dir: "/workspace/peon",
    agent: "codex-app-server",
    backendSessionId: null,
    backendTurnId: null,
    backendRuntimeGeneration: null,
    backendTurnStatus: null,
    model: null,
    reasoningEffort: null,
    projectId: "project-1",
    projectKey: "peon",
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: "owner@example.com",
    parentSessionId: null,
    spawnDepth: 0,
    spawnRequestId: null,
    parentCompletionNotifiedAt: null,
    parentCompletionNotificationPending: false,
    expectsOutcome: false,
    status: "running",
    outcome: null,
    startedAt: 1,
    endedAt: null,
    turnCount: 0,
    turnBudget: 0,
    usage: null,
    usageByModel: {},
    contextUsage: null,
    autoResumeAttempts: 0,
    lastActivityAt: 1,
    lastUserMessageAt: 1,
    lastMessagePreview: null,
    eventCount: 0,
    ...overrides,
  };
}

function options(): SessionSpawnOptions {
  return {
    defaultAgent: "codex-app-server",
    projects: [
      { projectId: "project-1", key: "peon", label: "Peon", dir: "/workspace/peon" },
      { projectId: "project-2", key: "other", label: "Other", dir: "/workspace/other" },
    ],
    providers: [
      {
        agent: "codex-app-server",
        label: "Codex",
        models: [
          { id: "gpt-5.6-sol", label: "Sol", default: true },
          { id: "gpt-5.4-mini", label: "Mini" },
        ],
        reasoningEfforts: [
          { id: "medium", label: "Medium", default: true },
          { id: "high", label: "High" },
        ],
        available: true,
      },
      {
        agent: "claude-code",
        label: "Claude",
        models: [{ id: "claude-sonnet-5", alias: "sonnet", label: "Sonnet", default: true }],
        reasoningEfforts: [{ id: "high", label: "High", default: true }],
        available: true,
      },
    ],
  };
}

class FakeStore implements SessionOrchestrationStore {
  readonly emitter = new EventEmitter();
  readonly records = new Map<string, SessionRecord>([["parent", record()]]);
  starts = 0;
  transcriptPage: TranscriptPage = { events: [], nextCursor: null, hasMore: false };
  transcriptRequests: Array<{ id: string; options: { limit: number; cursor?: string } }> = [];
  transcriptError: Error | null = null;
  systemEnqueueCalls: Array<{
    id: string;
    prompt: string;
    commandId?: string;
  }> = [];
  resumeCalls: Array<{
    id: string;
    prompt: string;
    author?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    commandId?: string;
  }> = [];

  get(id: string) { return this.records.get(id); }
  list() { return [...this.records.values()]; }
  start(input: {
    title?: string;
    prompt: string;
    dir: string;
    projectKey: string;
    expectsOutcome: boolean;
    author?: string;
    agent: CodingAgent;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    parentSessionId: string;
    spawnDepth: number;
    spawnRequestId: string;
  }) {
    this.starts += 1;
    const child = record({
      id: `child-${this.starts}`,
      title: input.title ?? null,
      prompt: input.prompt,
      dir: input.dir,
      projectId: input.projectKey === "peon" ? "project-1" : "project-2",
      projectKey: input.projectKey,
      agent: input.agent,
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      initiator: input.author ?? null,
      parentSessionId: input.parentSessionId,
      spawnDepth: input.spawnDepth,
      spawnRequestId: input.spawnRequestId,
      parentCompletionNotificationPending: true,
      expectsOutcome: input.expectsOutcome,
      startedAt: this.starts + 1,
    });
    this.records.set(child.id, child);
    this.emitter.emit("change", child);
    return child;
  }
  on(event: "change" | "delete", listener: (...args: unknown[]) => void): void;
  on(event: "complete", listener: (record: SessionRecord) => void): void;
  on(event: "change" | "delete" | "complete", listener: (...args: unknown[]) => void) {
    this.emitter.on(event, listener);
  }
  off(event: "change" | "delete", listener: (...args: unknown[]) => void): void;
  off(event: "complete", listener: (record: SessionRecord) => void): void;
  off(event: "change" | "delete" | "complete", listener: (...args: unknown[]) => void) {
    this.emitter.off(event, listener);
  }
  async getTranscriptPage(id: string, options: { limit: number; cursor?: string }) {
    this.transcriptRequests.push({ id, options });
    if (this.transcriptError) throw this.transcriptError;
    return structuredClone(this.transcriptPage);
  }
  enqueueSystem(
    id: string,
    prompt: string,
    commandId?: string,
  ) {
    const target = this.records.get(id);
    if (!target) throw new Error("unknown session");
    this.systemEnqueueCalls.push({ id, prompt, commandId });
    target.pendingSystemPrompts.push({
      prompt,
      commandId: commandId ?? null,
      queuedAt: this.systemEnqueueCalls.length,
    });
    return target;
  }
  markParentCompletionNotified(id: string, completedAt: number) {
    const target = this.records.get(id);
    if (!target) throw new Error("unknown session");
    target.parentCompletionNotifiedAt = completedAt;
    target.parentCompletionNotificationPending = false;
    return target;
  }
  resume(
    id: string,
    prompt: string,
    _attachments: [] = [],
    _permissionMode?: string,
    author?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort,
    commandId?: string,
    notifyParentOnComplete?: boolean,
  ) {
    const target = this.records.get(id);
    if (!target) throw new Error("unknown session");
    this.resumeCalls.push({ id, prompt, author, model, reasoningEffort, commandId });
    target.followUpPrompts.push(prompt);
    target.parentCompletionNotificationPending = notifyParentOnComplete ?? false;
    target.status = "running";
    target.outcome = null;
    target.endedAt = null;
    return target;
  }
}

function service(store = new FakeStore()) {
  return { store, service: new SessionOrchestrationService(store, options) };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "task-1",
    prompt: "Inspect the selected project and report the exact result.",
    projectKey: "other",
    agent: "codex-app-server",
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    ...overrides,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof SessionSpawnError ? error.code : undefined;
}

test("lists compact live options without a child-count allowance", () => {
  const { service: orchestrator } = service();
  const first = orchestrator.listOptions("parent");
  assert.deepEqual(first.limits, { maxSpawnDepth: 1 });
  assert.deepEqual(first.projects.map((project) => project.key), ["peon", "other"]);

  orchestrator.spawn("parent", { sessions: [item()] });
  assert.deepEqual(orchestrator.listOptions("parent").limits, { maxSpawnDepth: 1 });
});

test("spawns a selected batch with persisted ancestry and human attribution", () => {
  const { store, service: orchestrator } = service();
  const result = orchestrator.spawn("parent", {
    sessions: [
      item({ name: "Inspect other project" }),
      item({
        requestId: "task-2",
        projectKey: "peon",
        agent: "claude-code",
        model: "sonnet",
        reasoningEffort: "high",
      }),
    ],
  });

  assert.equal(store.starts, 2);
  assert.deepEqual(result.replayed, []);
  assert.deepEqual(result.children.map((child) => [child.projectKey, child.agent, child.model]), [
    ["other", "codex-app-server", "gpt-5.4-mini"],
    ["peon", "claude-code", "claude-sonnet-5"],
  ]);
  assert.deepEqual(result.children.map((child) => child.name), ["Inspect other project", null]);
  assert.equal(store.get(result.children[0]!.id)?.title, "Inspect other project");
  for (const child of store.list().filter((candidate) => candidate.parentSessionId)) {
    assert.equal(child.parentSessionId, "parent");
    assert.equal(child.spawnDepth, 1);
    assert.equal(child.initiator, "owner@example.com");
    assert.equal(child.expectsOutcome, false);
  }
});

test("retries are idempotent and conflicting retries start no additional work", () => {
  const { store, service: orchestrator } = service();
  const first = orchestrator.spawn("parent", { sessions: [item()] });
  const replay = orchestrator.spawn("parent", { sessions: [item()] });
  assert.equal(store.starts, 1);
  assert.deepEqual(replay.replayed, ["task-1"]);
  assert.equal(replay.children[0]?.id, first.children[0]?.id);

  assert.throws(
    () => orchestrator.spawn("parent", { sessions: [item({ name: "Changed name" })] }),
    (error) => code(error) === "IDEMPOTENCY_CONFLICT",
  );

  assert.throws(
    () => orchestrator.spawn("parent", {
      sessions: [item({ requestId: "task-2", prompt: "novel" }), item({ requestId: "task-1", prompt: "changed" })],
    }),
    (error) => code(error) === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(store.starts, 1);
});

test("permits batches and retained child sets larger than the former cap", () => {
  const { store, service: orchestrator } = service();
  orchestrator.spawn("parent", {
    sessions: Array.from({ length: 8 }, (_, index) => item({ requestId: `task-${index}` })),
  });
  assert.equal(store.starts, 8);
  orchestrator.spawn("parent", {
    sessions: Array.from({ length: 8 }, (_, index) => item({ requestId: `more-${index}` })),
  });
  assert.equal(store.starts, 16);
});

test("spawned children are categorically denied further delegation", () => {
  const { service: orchestrator } = service();
  const child = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!;
  assert.throws(() => orchestrator.listOptions(child.id), (error) => code(error) === "SPAWN_DEPTH_LIMIT");
  assert.throws(
    () => orchestrator.spawn(child.id, { sessions: [item({ requestId: "grandchild" })] }),
    (error) => code(error) === "SPAWN_DEPTH_LIMIT",
  );
});

test("rejects invalid selections before starting any sessions", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ projectKey: "missing" }, "UNKNOWN_PROJECT"],
    [{ agent: "missing" }, "UNKNOWN_AGENT"],
    [{ model: "gpt-imaginary" }, "UNKNOWN_MODEL"],
    [{ reasoningEffort: "infinite" }, "UNKNOWN_EFFORT"],
    [{ requestId: "../unsafe" }, "BAD_REQUEST"],
    [{ name: "   " }, "BAD_REQUEST"],
    [{ name: "x".repeat(121) }, "BAD_REQUEST"],
    [{ name: "bad\nname" }, "BAD_REQUEST"],
  ];
  for (const [override, expected] of cases) {
    const { store, service: orchestrator } = service();
    assert.throws(
      () => orchestrator.spawn("parent", { sessions: [item(override)] }),
      (error) => code(error) === expected,
    );
    assert.equal(store.starts, 0);
  }
});

test("wait returns on completion and refuses unrelated session ids", async () => {
  const { store, service: orchestrator } = service();
  const childId = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!.id;
  store.records.set("unrelated", record({ id: "unrelated" }));
  await assert.rejects(
    orchestrator.wait("parent", { sessionIds: ["unrelated"], timeoutMs: 0 }),
    (error) => code(error) === "NOT_A_CHILD",
  );

  const waiting = orchestrator.wait("parent", { sessionIds: [childId], timeoutMs: 1_000 });
  const child = store.get(childId)!;
  child.status = "completed";
  child.outcome = { result: "success", summary: "done" };
  child.endedAt = 10;
  store.emitter.emit("change", child);
  const result = await waiting;
  assert.equal(result.completed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.children[0]?.outcome?.summary, "done");
  assert.equal(store.emitter.listenerCount("change"), 0);
  assert.equal(store.emitter.listenerCount("delete"), 0);
});

test("a completed automated child adds a hidden system trigger to its parent", () => {
  const { store, service: orchestrator } = service();
  const childId = orchestrator.spawn("parent", {
    sessions: [item({ name: "Dependency audit" })],
  }).children[0]!.id;
  const child = store.get(childId)!;
  child.status = "completed";
  child.endedAt = 123;
  store.emitter.emit("complete", child);

  assert.equal(store.systemEnqueueCalls.length, 1);
  assert.equal(store.systemEnqueueCalls[0]?.id, "parent");
  assert.equal(store.systemEnqueueCalls[0]?.commandId, `mcp-child-completed:${childId}:123`);
  assert.match(store.systemEnqueueCalls[0]!.prompt, new RegExp(childId));
  assert.match(store.systemEnqueueCalls[0]!.prompt, /Dependency audit/);
  assert.match(store.systemEnqueueCalls[0]!.prompt, /get_child_transcript/);
  assert.equal(store.get("parent")?.queuedFollowUps.length, 0);
  assert.equal(store.get("parent")?.pendingSystemPrompts.length, 1);
  assert.equal(child.parentCompletionNotifiedAt, 123);

  // Duplicate completion delivery for the same turn is ignored.
  store.emitter.emit("complete", child);
  assert.equal(store.systemEnqueueCalls.length, 1);

  // A later orchestration-initiated follow-up gets its own completion handoff.
  orchestrator.followUp("parent", {
    sessionId: childId,
    prompt: "Inspect the result again.",
    requestId: "retry-1",
  });
  assert.equal(child.parentCompletionNotificationPending, true);
  child.status = "completed";
  child.endedAt = 124;
  store.emitter.emit("complete", child);
  assert.equal(store.systemEnqueueCalls.length, 2);
  assert.equal(store.systemEnqueueCalls[1]?.commandId, `mcp-child-completed:${childId}:124`);

  // A manually initiated child turn does not trigger the parent.
  store.resume(childId, "Manual child message.");
  child.status = "completed";
  child.endedAt = 125;
  store.emitter.emit("complete", child);
  assert.equal(store.systemEnqueueCalls.length, 2);

  orchestrator.close();
  child.endedAt = 126;
  child.parentCompletionNotificationPending = true;
  store.emitter.emit("complete", child);
  assert.equal(store.systemEnqueueCalls.length, 2);
});

test("completion triggers skip roots but automated child turns notify despite queued work", () => {
  const { store, service: orchestrator } = service();
  const root = store.get("parent")!;
  root.status = "completed";
  root.endedAt = 10;
  store.emitter.emit("complete", root);

  const childId = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!.id;
  const child = store.get(childId)!;
  child.status = "completed";
  child.endedAt = 20;
  child.queuedFollowUps.push({
    type: "queue",
    id: "waiting",
    sessionId: child.id,
    prompt: "more work",
    attachments: [],
    permissionMode: null,
    author: null,
    model: null,
    reasoningEffort: null,
    commandId: null,
    queuedAt: 1,
  });
  store.emitter.emit("complete", child);
  assert.equal(store.systemEnqueueCalls.length, 1);
  assert.equal(store.systemEnqueueCalls[0]?.commandId, `mcp-child-completed:${childId}:20`);
  orchestrator.close();
});

test("zero-time wait is a non-blocking status poll", async () => {
  const { service: orchestrator } = service();
  const childId = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!.id;
  const result = await orchestrator.wait("parent", { sessionIds: [childId], timeoutMs: 0 });
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, true);
});

test("child transcript reads are direct-child-only, paginated, and character bounded", async () => {
  const { store, service: orchestrator } = service();
  const childId = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!.id;
  store.transcriptPage = {
    events: [
      { eventId: "event-1", type: "assistant", message: { content: [{ type: "text", text: "short" }] } },
      { eventId: "event-2", type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(50_000) }] } },
    ],
    nextCursor: "older_page",
    hasMore: true,
  };
  const result = await orchestrator.transcript("parent", {
    sessionId: childId,
    limit: 2,
    maxChars: 12_000,
    cursor: "newer_page",
  });
  assert.deepEqual(store.transcriptRequests, [{
    id: childId,
    options: { limit: 2, cursor: "newer_page" },
  }]);
  assert.equal(result.nextCursor, "older_page");
  assert.equal(result.hasMore, true);
  assert.equal(result.responseTruncated, true);
  assert.ok(JSON.stringify(result).length <= 12_000);
  assert.equal(result.events[0]?.type, "assistant");
  assert.equal(result.events[1]?.truncated, true);

  store.records.set("unrelated", record({ id: "unrelated" }));
  await assert.rejects(
    orchestrator.transcript("parent", { sessionId: "unrelated" }),
    (error) => code(error) === "NOT_A_CHILD",
  );
  assert.equal(store.transcriptRequests.length, 1);
});

test("child transcript validates hard limits and normalizes cursor errors", async () => {
  const { store, service: orchestrator } = service();
  const childId = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!.id;
  const invalid: Array<[Record<string, unknown>, string]> = [
    [{ sessionId: childId, limit: 21 }, "BAD_REQUEST"],
    [{ sessionId: childId, maxChars: 11_999 }, "BAD_REQUEST"],
    [{ sessionId: childId, cursor: "../bad" }, "BAD_CURSOR"],
  ];
  for (const [args, expected] of invalid) {
    await assert.rejects(orchestrator.transcript("parent", args), (error) => code(error) === expected);
  }
  store.transcriptError = new TranscriptPaginationError("BAD_CURSOR", "cursor belongs to another session");
  await assert.rejects(
    orchestrator.transcript("parent", { sessionId: childId, cursor: "valid_shape" }),
    (error) => code(error) === "BAD_CURSOR",
  );
});

test("follow-ups may target self, children, or unrelated sessions without a count cap", () => {
  const { store, service: orchestrator } = service();
  const childId = orchestrator.spawn("parent", { sessions: [item()] }).children[0]!.id;
  store.records.set("foreign", record({
    id: "foreign",
    agent: "claude-code",
    model: "claude-sonnet-5",
    status: "completed",
    endedAt: 10,
  }));

  const foreign = orchestrator.followUp("parent", {
    sessionId: "foreign",
    prompt: "  inspect again  ",
    model: "sonnet",
    reasoningEffort: "high",
    requestId: "foreign-1",
  });
  assert.equal(foreign.session.id, "foreign");
  assert.deepEqual(store.resumeCalls[0], {
    id: "foreign",
    prompt: "inspect again",
    author: "owner@example.com",
    model: "claude-sonnet-5",
    reasoningEffort: "high",
    commandId: "mcp-followup:parent:foreign-1",
  });

  for (let index = 0; index < 6; index += 1) {
    const target = index % 2 === 0 ? "parent" : childId;
    assert.equal(orchestrator.followUp("parent", {
      sessionId: target,
      prompt: `follow-up ${index}`,
    }).session.id, target);
  }
  assert.equal(store.resumeCalls.length, 7);
  assert.equal(store.get(childId)?.parentCompletionNotificationPending, true);
});

test("follow-ups validate only target existence and target-provider selections", () => {
  const { store, service: orchestrator } = service();
  store.records.set("foreign", record({ id: "foreign", agent: "claude-code" }));
  assert.throws(
    () => orchestrator.followUp("parent", { sessionId: "missing", prompt: "work" }),
    (error) => code(error) === "UNKNOWN_SESSION",
  );
  assert.throws(
    () => orchestrator.followUp("parent", { sessionId: "foreign", prompt: "work", model: "gpt-5.4-mini" }),
    (error) => code(error) === "UNKNOWN_MODEL",
  );
  assert.throws(
    () => orchestrator.followUp("parent", { sessionId: "foreign", prompt: "work", reasoningEffort: "minimal" }),
    (error) => code(error) === "UNKNOWN_EFFORT",
  );
  assert.throws(
    () => orchestrator.followUp("parent", { sessionId: "foreign", prompt: "work", requestId: "../bad" }),
    (error) => code(error) === "BAD_REQUEST",
  );
  assert.equal(store.resumeCalls.length, 0);
});
