import type { SessionRecord } from "./sessionTypes.js";

type InternalSessionFields =
  | "pendingSystemPrompts"
  | "parentCompletionNotifiedAt"
  | "parentCompletionNotificationPending";

export type PublicSessionRecord = Omit<SessionRecord, InternalSessionFields>;

export function toPublicSessionRecord(record: SessionRecord): PublicSessionRecord {
  const {
    pendingSystemPrompts: _pendingSystemPrompts,
    parentCompletionNotifiedAt: _parentCompletionNotifiedAt,
    parentCompletionNotificationPending: _parentCompletionNotificationPending,
    ...publicRecord
  } = record;
  return publicRecord;
}
