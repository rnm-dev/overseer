import { canonicalModel, narrowReasoningEffort, type AiProvider, type CodingAgent, type ReasoningEffort } from "../modelCatalog.js";
import type { SessionOutcome, SessionRecord, SessionStatus } from "../sessionTypes.js";
import {
  MAX_TRANSCRIPT_CURSOR_LENGTH,
  TranscriptPaginationError,
  type TranscriptPage,
} from "../transcriptPagination.js";

export const MAX_SESSION_SPAWN_DEPTH = 1;
export const MAX_SESSION_SPAWN_PROMPT_LENGTH = 50_000;
export const MAX_SESSION_SPAWN_NAME_LENGTH = 120;
export const MAX_SESSION_WAIT_MS = 30_000;
export const DEFAULT_CHILD_TRANSCRIPT_LIMIT = 10;
export const MAX_CHILD_TRANSCRIPT_LIMIT = 20;
export const DEFAULT_CHILD_TRANSCRIPT_CHARS = 12_000;
export const MIN_CHILD_TRANSCRIPT_CHARS = 12_000;
export const MAX_CHILD_TRANSCRIPT_CHARS = 30_000;

export type SessionSpawnErrorCode =
  | "UNKNOWN_PARENT"
  | "SPAWN_DEPTH_LIMIT"
  | "BAD_REQUEST"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_MODEL"
  | "UNKNOWN_EFFORT"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_A_CHILD"
  | "BAD_CURSOR"
  | "UNKNOWN_SESSION";

export class SessionSpawnError extends Error {
  constructor(readonly code: SessionSpawnErrorCode, message: string) {
    super(message);
  }
}

export interface SessionSpawnProject {
  projectId: string;
  key: string;
  label: string;
  dir: string;
}

export interface SessionSpawnOptions {
  defaultAgent: CodingAgent;
  projects: SessionSpawnProject[];
  providers: AiProvider[];
}

export interface SessionSpawnItem {
  requestId: string;
  name?: string;
  prompt: string;
  projectKey: string;
  agent: CodingAgent;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ChildSessionView {
  id: string;
  requestId: string | null;
  name: string | null;
  status: SessionStatus;
  outcome: SessionOutcome | null;
  projectKey: string | null;
  agent: CodingAgent;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  startedAt: number;
  endedAt: number | null;
}

export interface SessionOrchestrationStore {
  get(id: string): SessionRecord | undefined;
  list(): SessionRecord[];
  start(options: {
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
  }): SessionRecord;
  on(event: "change" | "delete", listener: (...args: unknown[]) => void): unknown;
  off(event: "change" | "delete", listener: (...args: unknown[]) => void): unknown;
  on(event: "complete", listener: (record: SessionRecord) => void): unknown;
  off(event: "complete", listener: (record: SessionRecord) => void): unknown;
  getTranscriptPage(id: string, options: { limit: number; cursor?: string }): Promise<TranscriptPage>;
  enqueueSystem(
    id: string,
    prompt: string,
    commandId?: string,
  ): SessionRecord;
  markParentCompletionNotified(id: string, completedAt: number): SessionRecord;
  resume(
    id: string,
    prompt: string,
    attachments?: [],
    permissionMode?: string,
    author?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort,
    commandId?: string,
    notifyParentOnComplete?: boolean,
  ): SessionRecord;
}

interface SpawnBatchInput {
  sessions: unknown[];
}

/**
 * Application boundary for agent-created sessions. Ancestry checks live here
 * so every transport gets the same recursion-safety guarantees.
 */
export class SessionOrchestrationService {
  private readonly onChildComplete = (record: SessionRecord): void => {
    if (
      !record.parentSessionId
      || record.spawnDepth !== 1
      || record.status !== "completed"
      || record.endedAt === null
      || record.parentCompletionNotificationPending !== true
    ) return;
    const parent = this.store.get(record.parentSessionId);
    if (!parent) return;
    const request = record.spawnRequestId ? ` (requestId: ${record.spawnRequestId})` : "";
    const project = record.projectKey ? ` in project ${record.projectKey}` : "";
    const name = record.title ? ` named ${JSON.stringify(record.title)}` : "";
    const prompt = [
      `[Peon automation] Child session ${record.id}${name}${request}${project} has completed.`,
      `Process its result now. Use get_child_transcript with sessionId "${record.id}" to read its final assistant response and relevant events, then continue the parent task.`,
    ].join(" ");
    try {
      this.store.enqueueSystem(
        parent.id,
        prompt,
        `mcp-child-completed:${record.id}:${record.endedAt}`,
      );
      this.store.markParentCompletionNotified(record.id, record.endedAt);
    } catch (error) {
      console.error(
        `failed to enqueue completion trigger for child ${record.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  constructor(
    private readonly store: SessionOrchestrationStore,
    private readonly options: () => SessionSpawnOptions,
  ) {
    store.on("complete", this.onChildComplete);
  }

  close(): void {
    this.store.off("complete", this.onChildComplete);
  }

  listOptions(parentSessionId: string): SessionSpawnOptions & {
    limits: { maxSpawnDepth: number };
  } {
    this.requireRoot(parentSessionId);
    const options = this.options();
    return {
      ...options,
      limits: {
        maxSpawnDepth: MAX_SESSION_SPAWN_DEPTH,
      },
    };
  }

  spawn(parentSessionId: string, input: unknown): { children: ChildSessionView[]; replayed: string[] } {
    const parent = this.requireRoot(parentSessionId);
    const body = object(input);
    const rawItems = (body as unknown as SpawnBatchInput).sessions;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new SessionSpawnError("BAD_REQUEST", "sessions must be a non-empty array");
    }
    const available = this.options();
    const parsed = rawItems.map((item) => this.parseItem(item, available));
    if (new Set(parsed.map((item) => item.requestId)).size !== parsed.length) {
      throw new SessionSpawnError("BAD_REQUEST", "requestId values must be unique within a batch");
    }

    const existingChildren = this.childrenOf(parent.id);
    const byRequest = new Map(existingChildren.map((child) => [child.spawnRequestId, child]));

    // Validate every replay before starting any novel work. A conflicting
    // retry must not partially launch the remainder of its batch.
    for (const item of parsed) {
      const existing = byRequest.get(item.requestId);
      if (existing && !sameSpawn(existing, item)) {
        throw new SessionSpawnError(
          "IDEMPOTENCY_CONFLICT",
          `requestId ${item.requestId} was already used with different session parameters`,
        );
      }
    }

    const replayed: string[] = [];
    const children = parsed.map((item) => {
      const existing = byRequest.get(item.requestId);
      if (existing) {
        replayed.push(item.requestId);
        return view(existing);
      }
      const project = available.projects.find((candidate) => candidate.key === item.projectKey)!;
      const child = this.store.start({
        title: item.name,
        prompt: item.prompt,
        dir: project.dir,
        projectKey: project.key,
        expectsOutcome: false,
        author: parent.initiator ?? undefined,
        agent: item.agent,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        parentSessionId: parent.id,
        spawnDepth: 1,
        spawnRequestId: item.requestId,
      });
      byRequest.set(item.requestId, child);
      return view(child);
    });
    return { children, replayed };
  }

  children(parentSessionId: string): { children: ChildSessionView[] } {
    this.requireParent(parentSessionId);
    return { children: this.childrenOf(parentSessionId).map(view) };
  }

  async wait(
    parentSessionId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ completed: boolean; timedOut: boolean; children: ChildSessionView[] }> {
    this.requireParent(parentSessionId);
    const body = object(input);
    const requestedIds = body.sessionIds === undefined
      ? this.childrenOf(parentSessionId).map((child) => child.id)
      : stringArray(body.sessionIds, "sessionIds");
    const uniqueIds = [...new Set(requestedIds)];
    const timeoutMs = body.timeoutMs === undefined ? MAX_SESSION_WAIT_MS : integer(body.timeoutMs, "timeoutMs");
    if (timeoutMs < 0 || timeoutMs > MAX_SESSION_WAIT_MS) {
      throw new SessionSpawnError("BAD_REQUEST", `timeoutMs must be between 0 and ${MAX_SESSION_WAIT_MS}`);
    }
    this.requireChildren(parentSessionId, uniqueIds);

    const snapshot = () => uniqueIds.map((id) => this.store.get(id)).filter((record): record is SessionRecord => Boolean(record));
    const done = () => snapshot().every((record) => record.status === "completed");
    if (done() || timeoutMs === 0 || signal?.aborted) {
      return { completed: done(), timedOut: !done(), children: snapshot().map(view) };
    }

    let timedOut = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.store.off("change", changed);
        this.store.off("delete", changed);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const changed = () => {
        if (done()) finish();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        finish();
      }, timeoutMs);
      this.store.on("change", changed);
      this.store.on("delete", changed);
      signal?.addEventListener("abort", finish, { once: true });
      // Close the subscribe/snapshot race.
      changed();
    });
    return { completed: done(), timedOut: timedOut && !done(), children: snapshot().map(view) };
  }

  async transcript(
    parentSessionId: string,
    input: unknown,
  ): Promise<{
    sessionId: string;
    events: Array<Record<string, unknown>>;
    nextCursor: string | null;
    hasMore: boolean;
    responseTruncated: boolean;
  }> {
    this.requireParent(parentSessionId);
    const body = object(input);
    const sessionId = boundedString(body.sessionId, "sessionId", 200);
    this.requireChildren(parentSessionId, [sessionId]);
    const limit = body.limit === undefined ? DEFAULT_CHILD_TRANSCRIPT_LIMIT : integer(body.limit, "limit");
    if (limit < 1 || limit > MAX_CHILD_TRANSCRIPT_LIMIT) {
      throw new SessionSpawnError("BAD_REQUEST", `limit must be between 1 and ${MAX_CHILD_TRANSCRIPT_LIMIT}`);
    }
    const maxChars = body.maxChars === undefined
      ? DEFAULT_CHILD_TRANSCRIPT_CHARS
      : integer(body.maxChars, "maxChars");
    if (maxChars < MIN_CHILD_TRANSCRIPT_CHARS || maxChars > MAX_CHILD_TRANSCRIPT_CHARS) {
      throw new SessionSpawnError(
        "BAD_REQUEST",
        `maxChars must be between ${MIN_CHILD_TRANSCRIPT_CHARS} and ${MAX_CHILD_TRANSCRIPT_CHARS}`,
      );
    }
    const cursor = optionalCursor(body.cursor);
    let page: TranscriptPage;
    try {
      page = await this.store.getTranscriptPage(sessionId, { limit, ...(cursor ? { cursor } : {}) });
    } catch (error) {
      if (error instanceof TranscriptPaginationError) {
        throw new SessionSpawnError(error.code === "BAD_CURSOR" ? "BAD_CURSOR" : "BAD_REQUEST", error.message);
      }
      throw error;
    }
    return boundedTranscriptPage(sessionId, page, maxChars);
  }

  followUp(
    senderSessionId: string,
    input: unknown,
  ): { session: ChildSessionView } {
    const sender = this.requireParent(senderSessionId);
    const body = object(input);
    const sessionId = boundedString(body.sessionId, "sessionId", 200);
    const target = this.store.get(sessionId);
    if (!target) throw new SessionSpawnError("UNKNOWN_SESSION", `unknown session: ${sessionId}`);
    const prompt = requiredString(body.prompt, "prompt");
    const model = body.model === undefined
      ? undefined
      : canonicalModel(target.agent, boundedString(body.model, "model", 200));
    if (body.model !== undefined && !model) {
      throw new SessionSpawnError("UNKNOWN_MODEL", `model is not valid for ${target.agent}: ${String(body.model)}`);
    }
    const reasoningEffort = body.reasoningEffort === undefined
      ? undefined
      : narrowReasoningEffort(body.reasoningEffort, target.agent, model ?? target.model);
    if (body.reasoningEffort !== undefined && !reasoningEffort) {
      throw new SessionSpawnError(
        "UNKNOWN_EFFORT",
        `reasoning effort is not valid for ${target.agent}: ${String(body.reasoningEffort)}`,
      );
    }
    const requestId = body.requestId === undefined ? undefined : safeRequestId(body.requestId);
    const record = this.store.resume(
      sessionId,
      prompt,
      [],
      undefined,
      sender.initiator ?? undefined,
      model,
      reasoningEffort,
      requestId ? `mcp-followup:${sender.id}:${requestId}` : undefined,
      true,
    );
    return { session: view(record) };
  }

  private requireParent(id: string): SessionRecord {
    const record = this.store.get(id);
    if (!record) throw new SessionSpawnError("UNKNOWN_PARENT", "unknown parent session");
    return record;
  }

  private requireRoot(id: string): SessionRecord {
    const record = this.requireParent(id);
    if (record.parentSessionId !== null || record.spawnDepth !== 0) {
      throw new SessionSpawnError(
        "SPAWN_DEPTH_LIMIT",
        "spawned sessions cannot create more sessions; maximum delegation depth is one",
      );
    }
    return record;
  }

  private childrenOf(parentId: string): SessionRecord[] {
    return this.store.list()
      .filter((record) => record.parentSessionId === parentId)
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  }

  private requireChildren(parentId: string, ids: string[]): void {
    for (const id of ids) {
      const record = this.store.get(id);
      if (!record || record.parentSessionId !== parentId) {
        throw new SessionSpawnError("NOT_A_CHILD", `session ${id} is not a child of ${parentId}`);
      }
    }
  }

  private parseItem(value: unknown, options: SessionSpawnOptions): SessionSpawnItem {
    const item = object(value);
    const requestId = boundedString(item.requestId, "requestId", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
      throw new SessionSpawnError("BAD_REQUEST", "requestId contains unsupported characters");
    }
    const prompt = boundedString(item.prompt, "prompt", MAX_SESSION_SPAWN_PROMPT_LENGTH);
    const name = item.name === undefined
      ? undefined
      : boundedString(item.name, "name", MAX_SESSION_SPAWN_NAME_LENGTH);
    if (name && /[\u0000-\u001f\u007f]/.test(name)) {
      throw new SessionSpawnError("BAD_REQUEST", "name must not contain control characters");
    }
    const projectKey = boundedString(item.projectKey, "projectKey", 200);
    if (!options.projects.some((project) => project.key === projectKey)) {
      throw new SessionSpawnError("UNKNOWN_PROJECT", `unknown project: ${projectKey}`);
    }
    const agentValue = boundedString(item.agent, "agent", 100);
    const provider = options.providers.find((candidate) => candidate.agent === agentValue && candidate.available !== false);
    if (!provider) throw new SessionSpawnError("UNKNOWN_AGENT", `agent is not available: ${agentValue}`);
    const agent = provider.agent;
    const model = item.model === undefined ? undefined : canonicalModel(agent, boundedString(item.model, "model", 200));
    if (item.model !== undefined && !model) {
      throw new SessionSpawnError("UNKNOWN_MODEL", `model is not valid for ${agent}: ${String(item.model)}`);
    }
    const reasoningEffort = item.reasoningEffort === undefined
      ? undefined
      : narrowReasoningEffort(item.reasoningEffort, agent, model);
    if (item.reasoningEffort !== undefined && !reasoningEffort) {
      throw new SessionSpawnError("UNKNOWN_EFFORT", `reasoning effort is not valid for ${agent}: ${String(item.reasoningEffort)}`);
    }
    return { requestId, name, prompt, projectKey, agent, model, reasoningEffort };
  }
}

function view(record: SessionRecord): ChildSessionView {
  return {
    id: record.id,
    requestId: record.spawnRequestId,
    name: record.title,
    status: record.status,
    outcome: record.outcome,
    projectKey: record.projectKey,
    agent: record.agent,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function sameSpawn(record: SessionRecord, item: SessionSpawnItem): boolean {
  return record.prompt === item.prompt
    && record.title === (item.name ?? null)
    && record.projectKey === item.projectKey
    && record.agent === item.agent
    // Against what the child was *created* with: a follow-up may since have
    // pinned a different model, and a legitimate replay of the spawn request
    // must not read as a conflicting one. Records written before this field
    // existed fall back to their current selection.
    && (record.createdModel === undefined ? record.model : record.createdModel) === (item.model ?? null)
    && (record.createdReasoningEffort === undefined ? record.reasoningEffort : record.createdReasoningEffort)
      === (item.reasoningEffort ?? null);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionSpawnError("BAD_REQUEST", "arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionSpawnError("BAD_REQUEST", `${field} is required`);
  }
  const result = value.trim();
  if (result.length > maximum) {
    throw new SessionSpawnError("BAD_REQUEST", `${field} must be at most ${maximum} characters`);
  }
  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new SessionSpawnError("BAD_REQUEST", `${field} must be an array of session ids`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SessionSpawnError("BAD_REQUEST", `${field} must be an integer`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionSpawnError("BAD_REQUEST", `${field} is required`);
  }
  return value.trim();
}

function safeRequestId(value: unknown): string {
  const requestId = boundedString(value, "requestId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
    throw new SessionSpawnError("BAD_REQUEST", "requestId contains unsupported characters");
  }
  return requestId;
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TRANSCRIPT_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new SessionSpawnError("BAD_CURSOR", "invalid transcript cursor");
  }
  return value;
}

function boundedTranscriptPage(
  sessionId: string,
  page: TranscriptPage,
  maxChars: number,
): {
  sessionId: string;
  events: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
  responseTruncated: boolean;
} {
  let eventBudget = Math.max(128, Math.floor((maxChars - 1_000) / Math.max(1, page.events.length)));
  let events = page.events.map((event) => boundedTranscriptEvent(event, eventBudget));
  let result = transcriptResult(sessionId, page, events);
  while (JSON.stringify(result).length > maxChars && eventBudget > 128) {
    eventBudget = Math.max(128, Math.floor(eventBudget / 2));
    events = page.events.map((event) => boundedTranscriptEvent(event, eventBudget));
    result = transcriptResult(sessionId, page, events);
  }
  if (JSON.stringify(result).length > maxChars) {
    events = page.events.map((event) => ({
      eventId: event.eventId,
      truncated: true,
    }));
    result = transcriptResult(sessionId, page, events);
  }
  return result;
}

function transcriptResult(
  sessionId: string,
  page: TranscriptPage,
  events: Array<Record<string, unknown>>,
) {
  return {
    sessionId,
    events,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    responseTruncated: events.some((event) => event.truncated === true),
  };
}

function boundedTranscriptEvent(
  event: TranscriptPage["events"][number],
  maximum: number,
): Record<string, unknown> {
  const serialized = JSON.stringify(event);
  if (serialized.length <= maximum) return event;
  const metadataChars = 160;
  return {
    eventId: event.eventId,
    type: typeof event.type === "string" ? event.type : "unknown",
    ...(typeof event.createdAt === "number" ? { createdAt: event.createdAt } : {}),
    truncated: true,
    preview: serialized.slice(0, Math.max(0, maximum - metadataChars)),
  };
}
