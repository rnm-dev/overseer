export function toPublicSessionRecord(record) {
    const { pendingSystemPrompts: _pendingSystemPrompts, bootstrapContext: _bootstrapContext, parentCompletionNotifiedAt: _parentCompletionNotifiedAt, parentCompletionNotificationPending: _parentCompletionNotificationPending, ...publicRecord } = record;
    return {
        ...publicRecord,
        origin: record.origin ?? "operator",
        trigger: record.origin === "trigger" ? record.trigger ?? null : null,
        settledState: record.status === "completed" ? record.settledState ?? null : null,
    };
}
