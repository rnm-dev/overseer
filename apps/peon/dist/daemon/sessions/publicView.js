export function toPublicSessionRecord(record) {
    const { pendingSystemPrompts: _pendingSystemPrompts, bootstrapContext: _bootstrapContext, parentCompletionNotifiedAt: _parentCompletionNotifiedAt, parentCompletionNotificationPending: _parentCompletionNotificationPending, ...publicRecord } = record;
    return publicRecord;
}
