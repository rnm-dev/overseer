import type { AgentEvent } from "../agents/index.js";
import type { CodingAgent, ReasoningEffort } from "../providers/modelCatalog.js";
import type { SessionPage } from "./sessionPagination.js";
import type { AttachmentInfo, QueuedFollowUp, ReplyTo, SessionOutcome, SessionRecord, SessionStats, StatsPeriod } from "./sessionTypes.js";

export interface StartSessionOptions {
  prompt: string;
  title?: string;
  dir?: string;
  projectKey?: string;
  taskKey?: string;
  taskTitle?: string | null;
  id?: string;
  expectsOutcome?: boolean;
  attachments?: AttachmentInfo[];
  permissionMode?: string;
  author?: string;
  commandId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  // Transport/body-provided sessions do not set these fields directly,
  // but orchestration and tests rely on their stable process-wide shape.
  agent?: CodingAgent;
  parentSessionId?: string;
  spawnDepth?: number;
  spawnRequestId?: string;
}

export interface SessionRecordEntry {
  id: string;
  event: AgentEvent;
}

export interface SessionTranscriptPage {
  events: Array<AgentEvent & { eventId: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SessionCatalogReader {
  get(id: string): SessionRecord | undefined;
  list(): SessionRecord[];
  page(options: { limit: number; cursor?: string; projectKey?: string }): SessionPage;
  statsForPeriod(period: StatsPeriod): SessionStats;
}

export interface SessionLifecycleContract {
  isBusy(): boolean;
  activeCount(): number;
  start(options: StartSessionOptions): SessionRecord;
  branch(id: string, options?: { id?: string; title?: string; lastTurnId?: string; author?: string }): Promise<SessionRecord>;
  resume(
    id: string,
    prompt: string,
    attachments?: AttachmentInfo[],
    permissionMode?: string,
    author?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort,
    commandId?: string,
    notifyParentOnComplete?: boolean,
    replyTo?: ReplyTo,
  ): SessionRecord;
  rename(id: string, title: string | null): SessionRecord | undefined;
  renameProjectKey(oldKey: string, newKey: string): number;
  cancel(id: string): boolean;
  delete(id: string): "deleted" | "not_found" | "running";
  markParentCompletionNotified(id: string, completedAt: number): SessionRecord;
  notifyShuttingDown(): void;
  flushTranscripts(): Promise<void>;
  restoreFromDisk(): void;
  resumeInterrupted(): Promise<void>;
  resumeQueued(): void;
}

export interface SessionQueueContract {
  validateReplyTo(id: string, replyTo: ReplyTo | undefined): ReplyTo | undefined;
  queued(id: string): QueuedFollowUp[] | undefined;
  enqueue(
    id: string,
    prompt: string,
    attachments?: AttachmentInfo[],
    permissionMode?: string,
    author?: string,
    model?: string,
    reasoningEffort?: ReasoningEffort,
    commandId?: string,
    startNow?: boolean,
    replyTo?: ReplyTo,
  ): SessionRecord;
  enqueueSystem(id: string, prompt: string, commandId?: string): SessionRecord;
  editQueued(id: string, itemId: string, prompt: string, replyTo?: ReplyTo | null): SessionRecord | "not_found" | "unknown_session";
  steerQueued(id: string, itemId: string): "steered" | "not_found" | "unknown_session";
  /** @deprecated Use steerQueued. */
  sendQueuedNow(id: string, itemId: string): "sent" | "not_found" | "unknown_session";
  removeQueued(id: string, itemId: string): "removed" | "not_found" | "unknown_session";
}

export type SessionJsonService =
  & Pick<SessionCatalogReader, "get" | "list" | "page">
  & Pick<SessionLifecycleContract, "start" | "branch" | "resume" | "rename" | "cancel" | "delete">
  & Pick<
    SessionQueueContract,
    "validateReplyTo" | "queued" | "enqueue" | "editQueued" | "steerQueued" | "sendQueuedNow" | "removeQueued"
  >;

export interface SessionTranscriptEventContract {
  getTranscript(id: string): AgentEvent[];
  getTranscriptEntries(id: string): SessionRecordEntry[];
  getTranscriptPage(id: string, options: { limit: number; cursor?: string }): Promise<SessionTranscriptPage>;
  preview(id: string, filePath: string, author?: string): AgentEvent | undefined;
  on(event: "event", listener: (payload: { sessionId: string; event: unknown; eventId: string }) => void): unknown;
  on(event: "change", listener: (record: SessionRecord) => void): unknown;
  on(event: "complete", listener: (record: SessionRecord) => void): unknown;
  on(event: "delete", listener: (sessionId: string) => void): unknown;
  off(event: "event", listener: (payload: { sessionId: string; event: unknown; eventId: string }) => void): unknown;
  off(event: "change", listener: (record: SessionRecord) => void): unknown;
  off(event: "complete", listener: (record: SessionRecord) => void): unknown;
  off(event: "delete", listener: (sessionId: string) => void): unknown;
}

export interface ProjectSessionContract {
  list(): Array<{ status: SessionRecord["status"]; projectKey: string | null; projectId: string | null; lastActivityAt: number; dir?: string | null }>;
  renameProjectKey(oldKey: string, newKey: string): number;
  start(options: {
    prompt: string;
    dir: string;
    projectKey: string;
    author?: string;
  }): SessionRecord;
  rename(id: string, title: string | null): SessionRecord | undefined;
}
