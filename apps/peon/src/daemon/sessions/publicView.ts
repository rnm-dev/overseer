import type { SessionRecord } from "./sessionTypes.js";

type InternalSessionFields =
  | "pendingSystemPrompts"
  | "parentCompletionNotifiedAt"
  | "parentCompletionNotificationPending"
  | "workflowExecution";

export type PublicSessionRecord = Omit<SessionRecord, InternalSessionFields>;

export function toPublicSessionRecord(record: SessionRecord): PublicSessionRecord {
  const {
    pendingSystemPrompts: _pendingSystemPrompts,
    parentCompletionNotifiedAt: _parentCompletionNotifiedAt,
    parentCompletionNotificationPending: _parentCompletionNotificationPending,
    workflowExecution: _workflowExecution,
    ...publicRecord
  } = record;
  return publicRecord;
}
