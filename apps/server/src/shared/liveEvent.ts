/**
 * The durable event-log record shared by the log, realtime adapters, and
 * post-commit delivery infrastructure. This is intentionally domain-neutral:
 * it describes a committed record, not a session or a notification.
 */
export type EventKind = "session" | "project" | "peon" | "attention" | "command" | "transcript" | "configuration";

export interface LiveEvent {
  cursor: number;
  workspaceId: string;
  peonId: string;
  sessionId: string | null;
  kind: EventKind;
  payload: unknown;
  createdAt: number;
}

export interface AppendInput {
  workspaceId: string;
  peonId: string;
  sessionId?: string | null;
  kind: EventKind;
  payload: unknown;
}
