export function toPublicSessionRecord(record) {
    const { pendingSystemPrompts: _pendingSystemPrompts, parentCompletionNotifiedAt: _parentCompletionNotifiedAt, parentCompletionNotificationPending: _parentCompletionNotificationPending, ...publicRecord } = record;
    return publicRecord;
}
