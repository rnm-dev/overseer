import type { AgentEvent } from "../agents/index.js";
import { assistantEventText } from "./sessionArtifacts.js";
import type { SessionRecord } from "./sessionTypes.js";

// The status of one request — the turn a create or a follow-up started — so an
// automation caller can wait for *its* turn rather than for the session, which
// may already be running someone else's. A follow-up is found by the commandId
// it was sent with; `INITIAL_REQUEST` names the turn that created the session.
//
// Derived, not stored: the queue says what is waiting, and the transcript's
// `user_message` events carry the commandId of the turn they opened.

export const REQUEST_STATUS_CAPABILITY = "session-request-status-v1";
export const INITIAL_REQUEST = "initial";
const MAX_TEXT = 16_000;

export type RequestState = "queued" | "running" | "completed" | "failed" | "unknown";

export interface RequestStatus {
  sessionId: string;
  requestId: string;
  status: RequestState;
  /** 1-based place in the session queue while queued. */
  queuePosition: number | null;
  /** The last top-level assistant text of the turn, bounded. */
  text: string | null;
  /** The session settled waiting on a sign-off after this turn. */
  awaitingSignoff: boolean;
  error: string | null;
}

function topLevelText(event: AgentEvent): string | null {
  if (event.type !== "assistant" || event.parent_tool_use_id !== undefined) return null;
  if ((event.message as Record<string, unknown> | undefined)?.model === "<synthetic>") return null;
  return assistantEventText(event);
}

export function requestStatus(record: SessionRecord, events: readonly AgentEvent[], requestId: string): RequestStatus {
  const base: RequestStatus = {
    sessionId: record.id, requestId, status: "unknown", queuePosition: null, text: null, awaitingSignoff: false, error: null,
  };
  const queued = record.queuedFollowUps.findIndex((item) => item.commandId === requestId);
  if (queued >= 0) return { ...base, status: "queued", queuePosition: queued + 1 };

  const starts = events.flatMap((event, index) => event.type === "user_message" ? [index] : []);
  const turn = requestId === INITIAL_REQUEST
    ? (starts.length > 0 ? 0 : -1)
    : starts.findIndex((index) => events[index]!.commandId === requestId);
  if (turn < 0) {
    // Accepted for a session that has not written its first turn yet.
    return requestId === INITIAL_REQUEST && record.status === "running" ? { ...base, status: "running" } : base;
  }
  const from = starts[turn]!;
  const isLast = turn === starts.length - 1;
  const to = isLast ? events.length : starts[turn + 1]!;
  let text: string | null = null;
  let result: AgentEvent | null = null;
  for (let index = from + 1; index < to; index += 1) {
    const event = events[index]!;
    const piece = topLevelText(event);
    if (piece) text = piece;
    if (event.type === "result") result = event;
  }
  const bounded = text && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  if (isLast && record.status === "running") return { ...base, status: "running", text: bounded };
  const failed = result?.is_error === true;
  const errors = Array.isArray(result?.errors) ? (result!.errors as unknown[]).filter((value): value is string => typeof value === "string") : [];
  return {
    ...base,
    status: failed ? "failed" : "completed",
    text: bounded,
    awaitingSignoff: isLast && record.settledState === "awaiting_signoff",
    error: failed ? (errors.join("; ") || "the turn failed") : null,
  };
}
