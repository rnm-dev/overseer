import { canonicalModel, narrowReasoningEffort } from "../modelCatalog.js";
import { MAX_TRANSCRIPT_CURSOR_LENGTH, TranscriptPaginationError, } from "../transcriptPagination.js";
export const MAX_SESSION_SPAWN_DEPTH = 1;
export const MAX_SESSION_SPAWN_PROMPT_LENGTH = 50_000;
export const MAX_SESSION_SPAWN_NAME_LENGTH = 120;
export const MAX_SESSION_WAIT_MS = 30_000;
export const DEFAULT_CHILD_TRANSCRIPT_LIMIT = 10;
export const MAX_CHILD_TRANSCRIPT_LIMIT = 20;
export const DEFAULT_CHILD_TRANSCRIPT_CHARS = 12_000;
export const MIN_CHILD_TRANSCRIPT_CHARS = 12_000;
export const MAX_CHILD_TRANSCRIPT_CHARS = 30_000;
export class SessionSpawnError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/**
 * Application boundary for agent-created sessions. Ancestry checks live here
 * so every transport gets the same recursion-safety guarantees.
 */
export class SessionOrchestrationService {
    store;
    options;
    onChildComplete = (record) => {
        if (!record.parentSessionId
            || record.spawnDepth !== 1
            || record.status !== "completed"
            || record.endedAt === null
            || record.parentCompletionNotificationPending !== true)
            return;
        const parent = this.store.get(record.parentSessionId);
        if (!parent)
            return;
        const request = record.spawnRequestId ? ` (requestId: ${record.spawnRequestId})` : "";
        const project = record.projectKey ? ` in project ${record.projectKey}` : "";
        const name = record.title ? ` named ${JSON.stringify(record.title)}` : "";
        const prompt = [
            `[Peon automation] Child session ${record.id}${name}${request}${project} has completed.`,
            `Process its result now. Use get_child_transcript with sessionId "${record.id}" to read its final assistant response and relevant events, then continue the parent task.`,
        ].join(" ");
        try {
            this.store.enqueueSystem(parent.id, prompt, `mcp-child-completed:${record.id}:${record.endedAt}`);
            this.store.markParentCompletionNotified(record.id, record.endedAt);
        }
        catch (error) {
            console.error(`failed to enqueue completion trigger for child ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    constructor(store, options) {
        this.store = store;
        this.options = options;
        store.on("complete", this.onChildComplete);
    }
    close() {
        this.store.off("complete", this.onChildComplete);
    }
    listOptions(parentSessionId) {
        this.requireRoot(parentSessionId);
        const options = this.options();
        return {
            ...options,
            limits: {
                maxSpawnDepth: MAX_SESSION_SPAWN_DEPTH,
            },
        };
    }
    spawn(parentSessionId, input) {
        const parent = this.requireRoot(parentSessionId);
        const body = object(input);
        const rawItems = body.sessions;
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
            throw new SessionSpawnError("BAD_REQUEST", "sessions must be a non-empty array");
        }
        const available = this.options();
        const parsed = rawItems.map((item) => this.parseItem(item, available));
        if (new Set(parsed.map((item) => item.requestId)).size !== parsed.length) {
            throw new SessionSpawnError("BAD_REQUEST", "requestId values must be unique within a batch");
        }
        const existingChildren = this.childrenOf(parent.id);
        const byRequest = new Map(existingChildren.map((child) => [child.spawnRequestId, child]));
        // Validate every replay before starting any novel work. A conflicting
        // retry must not partially launch the remainder of its batch.
        for (const item of parsed) {
            const existing = byRequest.get(item.requestId);
            if (existing && !sameSpawn(existing, item)) {
                throw new SessionSpawnError("IDEMPOTENCY_CONFLICT", `requestId ${item.requestId} was already used with different session parameters`);
            }
        }
        const replayed = [];
        const children = parsed.map((item) => {
            const existing = byRequest.get(item.requestId);
            if (existing) {
                replayed.push(item.requestId);
                return view(existing);
            }
            const project = available.projects.find((candidate) => candidate.key === item.projectKey);
            const child = this.store.start({
                title: item.name,
                prompt: item.prompt,
                dir: project.dir,
                projectKey: project.key,
                expectsOutcome: false,
                author: parent.initiator ?? undefined,
                agent: item.agent,
                model: item.model,
                reasoningEffort: item.reasoningEffort,
                parentSessionId: parent.id,
                spawnDepth: 1,
                spawnRequestId: item.requestId,
            });
            byRequest.set(item.requestId, child);
            return view(child);
        });
        return { children, replayed };
    }
    children(parentSessionId) {
        this.requireParent(parentSessionId);
        return { children: this.childrenOf(parentSessionId).map(view) };
    }
    async wait(parentSessionId, input, signal) {
        this.requireParent(parentSessionId);
        const body = object(input);
        const requestedIds = body.sessionIds === undefined
            ? this.childrenOf(parentSessionId).map((child) => child.id)
            : stringArray(body.sessionIds, "sessionIds");
        const uniqueIds = [...new Set(requestedIds)];
        const timeoutMs = body.timeoutMs === undefined ? MAX_SESSION_WAIT_MS : integer(body.timeoutMs, "timeoutMs");
        if (timeoutMs < 0 || timeoutMs > MAX_SESSION_WAIT_MS) {
            throw new SessionSpawnError("BAD_REQUEST", `timeoutMs must be between 0 and ${MAX_SESSION_WAIT_MS}`);
        }
        this.requireChildren(parentSessionId, uniqueIds);
        const snapshot = () => uniqueIds.map((id) => this.store.get(id)).filter((record) => Boolean(record));
        const done = () => snapshot().every((record) => record.status === "completed");
        if (done() || timeoutMs === 0 || signal?.aborted) {
            return { completed: done(), timedOut: !done(), children: snapshot().map(view) };
        }
        let timedOut = false;
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.store.off("change", changed);
                this.store.off("delete", changed);
                signal?.removeEventListener("abort", finish);
                resolve();
            };
            const changed = () => {
                if (done())
                    finish();
            };
            const timer = setTimeout(() => {
                timedOut = true;
                finish();
            }, timeoutMs);
            this.store.on("change", changed);
            this.store.on("delete", changed);
            signal?.addEventListener("abort", finish, { once: true });
            // Close the subscribe/snapshot race.
            changed();
        });
        return { completed: done(), timedOut: timedOut && !done(), children: snapshot().map(view) };
    }
    async transcript(parentSessionId, input) {
        this.requireParent(parentSessionId);
        const body = object(input);
        const sessionId = boundedString(body.sessionId, "sessionId", 200);
        this.requireChildren(parentSessionId, [sessionId]);
        const limit = body.limit === undefined ? DEFAULT_CHILD_TRANSCRIPT_LIMIT : integer(body.limit, "limit");
        if (limit < 1 || limit > MAX_CHILD_TRANSCRIPT_LIMIT) {
            throw new SessionSpawnError("BAD_REQUEST", `limit must be between 1 and ${MAX_CHILD_TRANSCRIPT_LIMIT}`);
        }
        const maxChars = body.maxChars === undefined
            ? DEFAULT_CHILD_TRANSCRIPT_CHARS
            : integer(body.maxChars, "maxChars");
        if (maxChars < MIN_CHILD_TRANSCRIPT_CHARS || maxChars > MAX_CHILD_TRANSCRIPT_CHARS) {
            throw new SessionSpawnError("BAD_REQUEST", `maxChars must be between ${MIN_CHILD_TRANSCRIPT_CHARS} and ${MAX_CHILD_TRANSCRIPT_CHARS}`);
        }
        const cursor = optionalCursor(body.cursor);
        let page;
        try {
            page = await this.store.getTranscriptPage(sessionId, { limit, ...(cursor ? { cursor } : {}) });
        }
        catch (error) {
            if (error instanceof TranscriptPaginationError) {
                throw new SessionSpawnError(error.code === "BAD_CURSOR" ? "BAD_CURSOR" : "BAD_REQUEST", error.message);
            }
            throw error;
        }
        return boundedTranscriptPage(sessionId, page, maxChars);
    }
    followUp(senderSessionId, input) {
        const sender = this.requireParent(senderSessionId);
        const body = object(input);
        const sessionId = boundedString(body.sessionId, "sessionId", 200);
        const target = this.store.get(sessionId);
        if (!target)
            throw new SessionSpawnError("UNKNOWN_SESSION", `unknown session: ${sessionId}`);
        const prompt = requiredString(body.prompt, "prompt");
        const model = body.model === undefined
            ? undefined
            : canonicalModel(target.agent, boundedString(body.model, "model", 200));
        if (body.model !== undefined && !model) {
            throw new SessionSpawnError("UNKNOWN_MODEL", `model is not valid for ${target.agent}: ${String(body.model)}`);
        }
        const reasoningEffort = body.reasoningEffort === undefined
            ? undefined
            : narrowReasoningEffort(body.reasoningEffort, target.agent, model ?? target.model);
        if (body.reasoningEffort !== undefined && !reasoningEffort) {
            throw new SessionSpawnError("UNKNOWN_EFFORT", `reasoning effort is not valid for ${target.agent}: ${String(body.reasoningEffort)}`);
        }
        const requestId = body.requestId === undefined ? undefined : safeRequestId(body.requestId);
        const record = this.store.resume(sessionId, prompt, [], undefined, sender.initiator ?? undefined, model, reasoningEffort, requestId ? `mcp-followup:${sender.id}:${requestId}` : undefined, true);
        return { session: view(record) };
    }
    requireParent(id) {
        const record = this.store.get(id);
        if (!record)
            throw new SessionSpawnError("UNKNOWN_PARENT", "unknown parent session");
        return record;
    }
    requireRoot(id) {
        const record = this.requireParent(id);
        if (record.parentSessionId !== null || record.spawnDepth !== 0) {
            throw new SessionSpawnError("SPAWN_DEPTH_LIMIT", "spawned sessions cannot create more sessions; maximum delegation depth is one");
        }
        return record;
    }
    childrenOf(parentId) {
        return this.store.list()
            .filter((record) => record.parentSessionId === parentId)
            .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    }
    requireChildren(parentId, ids) {
        for (const id of ids) {
            const record = this.store.get(id);
            if (!record || record.parentSessionId !== parentId) {
                throw new SessionSpawnError("NOT_A_CHILD", `session ${id} is not a child of ${parentId}`);
            }
        }
    }
    parseItem(value, options) {
        const item = object(value);
        const requestId = boundedString(item.requestId, "requestId", 128);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
            throw new SessionSpawnError("BAD_REQUEST", "requestId contains unsupported characters");
        }
        const prompt = boundedString(item.prompt, "prompt", MAX_SESSION_SPAWN_PROMPT_LENGTH);
        const name = item.name === undefined
            ? undefined
            : boundedString(item.name, "name", MAX_SESSION_SPAWN_NAME_LENGTH);
        if (name && /[\u0000-\u001f\u007f]/.test(name)) {
            throw new SessionSpawnError("BAD_REQUEST", "name must not contain control characters");
        }
        const projectKey = boundedString(item.projectKey, "projectKey", 200);
        if (!options.projects.some((project) => project.key === projectKey)) {
            throw new SessionSpawnError("UNKNOWN_PROJECT", `unknown project: ${projectKey}`);
        }
        const agentValue = boundedString(item.agent, "agent", 100);
        const provider = options.providers.find((candidate) => candidate.agent === agentValue && candidate.available !== false);
        if (!provider)
            throw new SessionSpawnError("UNKNOWN_AGENT", `agent is not available: ${agentValue}`);
        const agent = provider.agent;
        const model = item.model === undefined ? undefined : canonicalModel(agent, boundedString(item.model, "model", 200));
        if (item.model !== undefined && !model) {
            throw new SessionSpawnError("UNKNOWN_MODEL", `model is not valid for ${agent}: ${String(item.model)}`);
        }
        const reasoningEffort = item.reasoningEffort === undefined
            ? undefined
            : narrowReasoningEffort(item.reasoningEffort, agent, model);
        if (item.reasoningEffort !== undefined && !reasoningEffort) {
            throw new SessionSpawnError("UNKNOWN_EFFORT", `reasoning effort is not valid for ${agent}: ${String(item.reasoningEffort)}`);
        }
        return { requestId, name, prompt, projectKey, agent, model, reasoningEffort };
    }
}
function view(record) {
    return {
        id: record.id,
        requestId: record.spawnRequestId,
        name: record.title,
        status: record.status,
        outcome: record.outcome,
        projectKey: record.projectKey,
        agent: record.agent,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
    };
}
function sameSpawn(record, item) {
    return record.prompt === item.prompt
        && record.title === (item.name ?? null)
        && record.projectKey === item.projectKey
        && record.agent === item.agent
        // Against what the child was *created* with: a follow-up may since have
        // pinned a different model, and a legitimate replay of the spawn request
        // must not read as a conflicting one. Records written before this field
        // existed fall back to their current selection.
        && (record.createdModel === undefined ? record.model : record.createdModel) === (item.model ?? null)
        && (record.createdReasoningEffort === undefined ? record.reasoningEffort : record.createdReasoningEffort)
            === (item.reasoningEffort ?? null);
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SessionSpawnError("BAD_REQUEST", "arguments must be an object");
    }
    return value;
}
function boundedString(value, field, maximum) {
    if (typeof value !== "string" || !value.trim()) {
        throw new SessionSpawnError("BAD_REQUEST", `${field} is required`);
    }
    const result = value.trim();
    if (result.length > maximum) {
        throw new SessionSpawnError("BAD_REQUEST", `${field} must be at most ${maximum} characters`);
    }
    return result;
}
function stringArray(value, field) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
        throw new SessionSpawnError("BAD_REQUEST", `${field} must be an array of session ids`);
    }
    return value;
}
function integer(value, field) {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new SessionSpawnError("BAD_REQUEST", `${field} must be an integer`);
    }
    return value;
}
function requiredString(value, field) {
    if (typeof value !== "string" || !value.trim()) {
        throw new SessionSpawnError("BAD_REQUEST", `${field} is required`);
    }
    return value.trim();
}
function safeRequestId(value) {
    const requestId = boundedString(value, "requestId", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
        throw new SessionSpawnError("BAD_REQUEST", "requestId contains unsupported characters");
    }
    return requestId;
}
function optionalCursor(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string"
        || value.length === 0
        || value.length > MAX_TRANSCRIPT_CURSOR_LENGTH
        || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new SessionSpawnError("BAD_CURSOR", "invalid transcript cursor");
    }
    return value;
}
function boundedTranscriptPage(sessionId, page, maxChars) {
    let eventBudget = Math.max(128, Math.floor((maxChars - 1_000) / Math.max(1, page.events.length)));
    let events = page.events.map((event) => boundedTranscriptEvent(event, eventBudget));
    let result = transcriptResult(sessionId, page, events);
    while (JSON.stringify(result).length > maxChars && eventBudget > 128) {
        eventBudget = Math.max(128, Math.floor(eventBudget / 2));
        events = page.events.map((event) => boundedTranscriptEvent(event, eventBudget));
        result = transcriptResult(sessionId, page, events);
    }
    if (JSON.stringify(result).length > maxChars) {
        events = page.events.map((event) => ({
            eventId: event.eventId,
            truncated: true,
        }));
        result = transcriptResult(sessionId, page, events);
    }
    return result;
}
function transcriptResult(sessionId, page, events) {
    return {
        sessionId,
        events,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        responseTruncated: events.some((event) => event.truncated === true),
    };
}
function boundedTranscriptEvent(event, maximum) {
    const serialized = JSON.stringify(event);
    if (serialized.length <= maximum)
        return event;
    const metadataChars = 160;
    return {
        eventId: event.eventId,
        type: typeof event.type === "string" ? event.type : "unknown",
        ...(typeof event.createdAt === "number" ? { createdAt: event.createdAt } : {}),
        truncated: true,
        preview: serialized.slice(0, Math.max(0, maximum - metadataChars)),
    };
}
