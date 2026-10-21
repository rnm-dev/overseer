import type { SessionRecord } from "./sessionTypes.js";

type InternalSessionFields =
  | "pendingSystemPrompts"
  | "bootstrapContext"
  | "parentCompletionNotifiedAt"
  | "parentCompletionNotificationPending";

export type PublicSessionRecord = Omit<SessionRecord, InternalSessionFields>;

export function toPublicSessionRecord(record: SessionRecord): PublicSessionRecord {
  const {
    pendingSystemPrompts: _pendingSystemPrompts,
    bootstrapContext: _bootstrapContext,
    parentCompletionNotifiedAt: _parentCompletionNotifiedAt,
    parentCompletionNotificationPending: _parentCompletionNotificationPending,
    ...publicRecord
  } = record;
  return publicRecord;
}
