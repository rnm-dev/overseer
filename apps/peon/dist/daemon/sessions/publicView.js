export function toPublicSessionRecord(record) {
    const { pendingSystemPrompts: _pendingSystemPrompts, parentCompletionNotifiedAt: _parentCompletionNotifiedAt, parentCompletionNotificationPending: _parentCompletionNotificationPending, workflowExecution: _workflowExecution, ...publicRecord } = record;
    return publicRecord;
}
