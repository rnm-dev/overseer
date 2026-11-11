// Session sign-offs: the pure model. A sign-off is a head plus an append-only
// event log; everything the head says (status, current snapshot, assignees) is
// derived from the events, so the head can always be rebuilt. No I/O here —
// storage and delivery live in store.ts and service.ts. See docs/signoffs.md.
export const SIGNOFFS_CAPABILITY = "session-signoffs-v1";
export const LIMITS = {
    options: 6,
    actionsPerOption: 10,
    assignees: 10,
    contextExcerpts: 5,
    id: 64,
    title: 200,
    summary: 4_000,
    label: 200,
    rationale: 2_000,
    actionSummary: 500,
    actionDetail: 8_000,
    contextExcerpt: 1_000,
    assignee: 200,
    message: 8_000,
    resultNote: 2_000,
    snapshotBytes: 64 * 1024,
};
export const TERMINAL_STATUSES = new Set([
    "done", "partly_done", "failed", "rejected", "withdrawn", "superseded", "interrupted",
]);
export class SignoffError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
    get status() {
        switch (this.code) {
            case "BAD_REQUEST": return 400;
            case "UNKNOWN_SIGNOFF": return 404;
            case "SIGNOFF_SESSION_GONE": return 410;
            case "SIGNOFF_NOT_ALLOWED": return 403;
            default: return 409;
        }
    }
}
// --- validation ------------------------------------------------------------
function bad(message) {
    throw new SignoffError("BAD_REQUEST", message);
}
function text(value, field, max, required = true) {
    if (value === undefined || value === null || value === "") {
        if (required)
            bad(`${field} is required`);
        return undefined;
    }
    if (typeof value !== "string")
        bad(`${field} must be a string`);
    const trimmed = value.trim();
    if (!trimmed) {
        if (required)
            bad(`${field} is required`);
        return undefined;
    }
    if (trimmed.length > max)
        bad(`${field} exceeds ${max} characters`);
    return trimmed;
}
function identifier(value, field) {
    const id = text(value, field, LIMITS.id);
    if (!/^[A-Za-z0-9._-]+$/.test(id))
        bad(`${field} may contain only letters, digits, '.', '_' and '-'`);
    return id;
}
function list(value, field, max, min = 0) {
    if (value === undefined || value === null) {
        if (min > 0)
            bad(`${field} is required`);
        return [];
    }
    if (!Array.isArray(value))
        bad(`${field} must be an array`);
    if (value.length < min)
        bad(`${field} needs at least ${min} item${min === 1 ? "" : "s"}`);
    if (value.length > max)
        bad(`${field} allows at most ${max} items`);
    return value;
}
function object(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        bad(`${field} must be an object`);
    return value;
}
export function parseAssignees(value, field = "assignees") {
    const out = list(value, field, LIMITS.assignees).map((item, i) => text(item, `${field}[${i}]`, LIMITS.assignee));
    return [...new Set(out)];
}
export function parseSnapshot(value) {
    const raw = object(value, "snapshot");
    const optionIds = new Set();
    const options = list(raw.options, "options", LIMITS.options, 1).map((rawOption, i) => {
        const option = object(rawOption, `options[${i}]`);
        const id = identifier(option.id, `options[${i}].id`);
        if (optionIds.has(id))
            bad(`options[${i}].id '${id}' is not unique`);
        optionIds.add(id);
        const actionIds = new Set();
        // An option is a plan the agent would carry out; "do nothing" is what
        // rejecting is for, so every option names at least one action.
        const actions = list(option.actions, `options[${i}].actions`, LIMITS.actionsPerOption, 1).map((rawAction, j) => {
            const action = object(rawAction, `options[${i}].actions[${j}]`);
            const actionId = identifier(action.id, `options[${i}].actions[${j}].id`);
            if (actionIds.has(actionId))
                bad(`options[${i}].actions[${j}].id '${actionId}' is not unique`);
            actionIds.add(actionId);
            if (action.type !== undefined && action.type !== "freeform")
                bad(`options[${i}].actions[${j}].type must be "freeform"`);
            const detail = text(action.detail, `options[${i}].actions[${j}].detail`, LIMITS.actionDetail, false);
            return {
                id: actionId,
                summary: text(action.summary, `options[${i}].actions[${j}].summary`, LIMITS.actionSummary),
                ...(detail ? { detail } : {}),
                type: "freeform",
            };
        });
        const rationale = text(option.rationale, `options[${i}].rationale`, LIMITS.rationale, false);
        if (option.recommended !== undefined && typeof option.recommended !== "boolean")
            bad(`options[${i}].recommended must be a boolean`);
        return {
            id,
            label: text(option.label, `options[${i}].label`, LIMITS.label),
            ...(option.recommended === true ? { recommended: true } : {}),
            ...(rationale ? { rationale } : {}),
            actions,
        };
    });
    const rawContext = typeof raw.context === "string" ? [raw.context] : raw.context;
    const context = list(rawContext, "context", LIMITS.contextExcerpts)
        .map((item, i) => text(item, `context[${i}]`, LIMITS.contextExcerpt));
    const snapshot = {
        title: text(raw.title, "title", LIMITS.title),
        summary: text(raw.summary, "summary", LIMITS.summary),
        options,
        assignees: parseAssignees(raw.assignees),
        context,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > LIMITS.snapshotBytes) {
        bad(`snapshot exceeds ${LIMITS.snapshotBytes} bytes`);
    }
    return snapshot;
}
export function parseMessage(value, required) {
    return text(value, "message", LIMITS.message, required);
}
export function parseResults(value, option) {
    const known = new Set(option.actions.map((action) => action.id));
    const seen = new Set();
    const results = list(value, "results", LIMITS.actionsPerOption, 1).map((rawResult, i) => {
        const result = object(rawResult, `results[${i}]`);
        const actionId = identifier(result.actionId, `results[${i}].actionId`);
        if (!known.has(actionId))
            bad(`results[${i}].actionId '${actionId}' is not an action of the approved option`);
        if (seen.has(actionId))
            bad(`results[${i}].actionId '${actionId}' is reported twice`);
        seen.add(actionId);
        if (!["done", "failed", "skipped"].includes(result.outcome)) {
            bad(`results[${i}].outcome must be done, failed or skipped`);
        }
        const note = text(result.note, `results[${i}].note`, LIMITS.resultNote, false);
        return { actionId, outcome: result.outcome, ...(note ? { note } : {}) };
    });
    const missing = [...known].filter((id) => !seen.has(id));
    if (missing.length)
        bad(`results must report every action of the approved option; missing: ${missing.join(", ")}`);
    return results;
}
// --- derivation ------------------------------------------------------------
export function executedStatus(results) {
    const done = results.filter((result) => result.outcome === "done").length;
    if (done === results.length)
        return "done";
    return done === 0 ? "failed" : "partly_done";
}
/** Status after `event`, given the status before it. */
export function statusAfter(previous, event) {
    switch (event.kind) {
        case "proposed":
        case "revised":
        case "answered":
            return "pending";
        case "commented":
            return "changes_requested";
        case "approved":
            return "approved";
        case "rejected":
            return "rejected";
        case "reassigned":
            return previous ?? "pending";
        case "withdrawn":
            return "withdrawn";
        case "superseded":
            return "superseded";
        case "executing":
            return "executing";
        case "executed":
            return executedStatus(event.results ?? []);
        case "interrupted":
            return "interrupted";
    }
}
export function derive(events) {
    if (!events.length || events[0].kind !== "proposed" || !events[0].snapshot) {
        throw new Error("a sign-off history must start with a proposed event carrying a snapshot");
    }
    let status = null;
    let snapshot = events[0].snapshot;
    let snapshotSeq = events[0].seq;
    let assigneeIds = snapshot.assignees;
    let approval = null;
    events.forEach((event, index) => {
        if (event.seq !== index + 1)
            throw new Error(`sign-off history is not contiguous at seq ${event.seq}`);
        if (event.snapshot) {
            snapshot = event.snapshot;
            snapshotSeq = event.seq;
            assigneeIds = event.snapshot.assignees;
        }
        if (event.assigneeIds)
            assigneeIds = event.assigneeIds;
        if (event.kind === "approved")
            approval = event;
        if (event.kind === "revised")
            approval = null;
        status = statusAfter(status, event);
    });
    return { status: status, snapshot, snapshotSeq, assigneeIds, approval };
}
export function approvedOption(derived, events) {
    const approval = derived.approval;
    if (!approval?.optionId || approval.baseSeq === null)
        throw new SignoffError("SIGNOFF_STATE", "the sign-off has no approval in force");
    // The approved text is the one at baseSeq, frozen; a later revision cannot
    // change what was decided.
    const snapshot = snapshotAt(events, approval.baseSeq);
    const option = snapshot.options.find((candidate) => candidate.id === approval.optionId);
    if (!option)
        throw new Error(`approved option ${approval.optionId} is missing from seq ${approval.baseSeq}`);
    return option;
}
export function snapshotAt(events, seq) {
    let snapshot;
    for (const event of events) {
        if (event.seq > seq)
            break;
        if (event.snapshot)
            snapshot = event.snapshot;
    }
    if (!snapshot)
        throw new Error(`no snapshot at or before seq ${seq}`);
    return snapshot;
}
/** Rebuilds the head from its identity fields and the event log. */
export function rebuildHead(identity, events) {
    const derived = derive(events);
    const last = events[events.length - 1];
    return {
        ...identity,
        headSeq: last.seq,
        status: derived.status,
        assigneeIds: derived.assigneeIds,
        updatedAt: last.createdAt,
    };
}
export function displayNumber(head) {
    return `SO-${head.number}`;
}
