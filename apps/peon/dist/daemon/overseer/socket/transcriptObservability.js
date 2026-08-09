const CAPABILITIES = ["transcript-sync-v1", "other"];
const admissions = new Map();
let pending = Object.freeze({
    "transcript-sync-v1": { count: 0, bytes: 0, oldestAgeMs: 0 },
    other: { count: 0, bytes: 0, oldestAgeMs: 0 },
});
function capability(value) {
    return value === "transcript-sync-v1" ? value : "other";
}
export function observeTranscriptAdmission(input) {
    if (capability(input.capability) !== "transcript-sync-v1")
        return;
    const key = input.result;
    const current = admissions.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += Math.max(0, input.elapsedMs);
    current.maxMs = Math.max(current.maxMs, input.elapsedMs);
    admissions.set(key, current);
}
export function observeOutboxPending(messages, now = Date.now()) {
    const next = {
        "transcript-sync-v1": { count: 0, bytes: 0, oldestAgeMs: 0 },
        other: { count: 0, bytes: 0, oldestAgeMs: 0 },
    };
    for (const message of messages) {
        const bucket = next[capability(message.capability)];
        bucket.count += 1;
        bucket.bytes += Math.max(0, message.payloadBytes);
        bucket.oldestAgeMs = Math.max(bucket.oldestAgeMs, Math.max(0, now - message.createdAt));
    }
    pending = Object.freeze(next);
}
export function peonTranscriptObservabilitySnapshot() {
    return Object.freeze({ admissions: Object.freeze(Object.fromEntries(admissions)), pending });
}
export function resetPeonTranscriptObservabilityForTest() {
    admissions.clear();
    observeOutboxPending([], 0);
}
