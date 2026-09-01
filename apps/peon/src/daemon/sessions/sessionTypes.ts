import type { CodingAgent, ReasoningEffort } from "../providers/modelCatalog.js";
import type { ContextMention, PrincipalSnapshot } from "./contextMessages.js";

export interface SessionOutcome {
  result: "success" | "failure" | "needs_human";
  summary: string;
  // Optional only for records persisted by older Peon versions. New
  // outcome-producing runs normalize absence to an explicit null.
  previewPath?: string | null;
}

export type SessionStatus = "running" | "completed";
export type BackendTurnStatus = "inProgress" | "completed" | "interrupted" | "failed" | "unknown";

export interface AttachmentInfo {
  originalName: string;
  filename: string;
  path: string;
  size: number;
  mimetype: string;
}

/**
 * A durable reference to text selected in one earlier transcript event.
 * `selectedText` is intentionally the operator-visible selection, not an
 * offset into provider output: Peon owns the transcript and can preserve this
 * display context even when a client only has a paged slice loaded.
 */
export interface ReplyTo {
  eventId: string;
  selectedText: string;
}

export interface QueuedFollowUp {
  id: string;
  type: "queue" | "steer";
  sessionId: string;
  prompt: string;
  attachments: AttachmentInfo[];
  permissionMode: string | null;
  author: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  commandId: string | null;
  replyTo: ReplyTo | null;
  /** Structured attribution resolved by Overseer; never used to route this item. */
  authorPrincipal: PrincipalSnapshot | null;
  mentions: ContextMention[] | null;
  queuedAt: number;
}

export interface PendingSystemPrompt {
  prompt: string;
  commandId: string | null;
  queuedAt: number;
}

export interface SessionUsage {
  totalCostUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export interface SessionContextUsage {
  currentTokens: number;
  limitTokens: number;
  updatedAt: number;
}

export interface SessionRecord {
  id: string;
  prompt: string;
  title: string | null;
  followUpPrompts: string[];
  queuedFollowUps: QueuedFollowUp[];
  /** Durable automation context coalesced into the next turn; never exposed in public session views. */
  pendingSystemPrompts: PendingSystemPrompt[];
  dir: string;
  agent: CodingAgent;
  // Provider-owned conversation id. Claude can use `id` directly; Codex
  // allocates a thread id and reports it in its first JSON event.
  backendSessionId: string | null;
  // Native provider turn identity used to reconcile a daemon/runtime restart
  // without replaying an already accepted user message.
  backendTurnId: string | null;
  backendRuntimeGeneration: number | null;
  backendTurnStatus: BackendTurnStatus | null;
  /** Latest explicit selection: a follow-up that names a model pins it here for the rest of the conversation. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** The selection this session was *created* with. Immutable, so spawn idempotency keeps comparing like with like. */
  createdModel?: string | null;
  createdReasoningEffort?: ReasoningEffort | null;
  /** Stable project identity; null only for ad-hoc or unresolvable legacy sessions. */
  projectId: string | null;
  projectKey: string | null;
  candidateProjectKeys: string[];
  taskKey: string | null;
  taskTitle: string | null;
  initiator: string | null;
  /** Peon session whose provider context was copied to create this session. */
  branchedFromSessionId?: string | null;
  /** Direct Peon session that delegated this work; null for human/fleet-created roots. */
  parentSessionId: string | null;
  /** Persisted delegation depth. MCP orchestration currently permits roots only (depth zero). */
  spawnDepth: number;
  /** Parent-scoped idempotency key for an MCP-created child. */
  spawnRequestId: string | null;
  /** Completion timestamp most recently handed back to the parent (durable event deduplication). */
  parentCompletionNotifiedAt: number | null;
  /** True only while an orchestration-initiated child turn still owes its parent a completion handoff. */
  parentCompletionNotificationPending?: boolean;
  expectsOutcome: boolean;
  status: SessionStatus;
  outcome: SessionOutcome | null;
  startedAt: number;
  endedAt: number | null;
  turnCount: number;
  turnBudget: number;
  usage: SessionUsage | null;
  usageByModel: Record<string, SessionUsage>;
  contextUsage?: SessionContextUsage | null;
  autoResumeAttempts: number;
  lastActivityAt: number;
  lastUserMessageAt: number;
  lastMessagePreview: string | null;
  eventCount: number;
}

export type StatsPeriod = "day" | "yesterday" | "week" | "month";

export interface SessionStats {
  semanticsVersion: number;
  period: StatsPeriod;
  rangeStart: number;
  rangeEnd: number;
  /** Current logical size of the complete persisted sessions store. */
  sessionsSizeBytes: number;
  sessionCount: number;
  outcomeCounts: { success: number; failure: number; needs_human: number; none: number; running: number };
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  /** Canonical provider-neutral token total. `totalTokens` is retained as a compatibility alias. */
  processedTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  sessionsWithUsage: number;
  sessionsMissingUsage: number;
  usageCoveragePercent: number;
  usageRejections: Partial<Record<import("./tokenUsage.js").TokenUsageRejectionReason, number>>;
  byModel: Array<{
    /** Canonical public provider id, which may differ from the session runtime id. */
    agent: CodingAgent;
    model: string;
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    processedTokens: number;
    totalDurationMs: number;
    totalCostUsd: number;
  }>;
}
