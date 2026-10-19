import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CommittedTranscriptLimitError, flushTranscript, readCommittedTranscriptEntriesBoundedAsync, sessionsDir } from "./sessionArtifacts.js";
import { isReplyableEvent } from "./replyTo.js";
export const MESSAGE_THREADS_CAPABILITY = "message-threads-v1";
export const MAX_THREAD_MESSAGES = 100;
export const MAX_THREAD_TEXT_BYTES = 16 * 1024;
const MAX_CAPSULE_SOURCE_BYTES = 96 * 1024;
const MAX_CAPSULE_BYTES = 128 * 1024;
const MAX_CAPSULE_EVENTS = 24;
const MAX_THREAD_STATE_BYTES = 4 * 1024 * 1024;
const MAX_THREADS = 64;
const MAX_TRANSCRIPT_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_EVENTS = 20_000;
const MAX_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
const mutationTails = new Map();
async function withThreadMutation(sessionId, operation) {
    const previous = mutationTails.get(sessionId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    mutationTails.set(sessionId, tail);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (mutationTails.get(sessionId) === tail)
            mutationTails.delete(sessionId);
    }
}
export class MessageThreadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const empty = () => ({ version: 1, threads: [], commands: {} });
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const principalSchema = z.object({ kind: z.enum(["user", "guest"]), id: z.string().regex(safeId), label: z.string().trim().min(1).max(80) }).strict();
const messageSchema = z.object({ id: z.uuid(), commandId: z.string().regex(safeId), text: z.string().min(1).max(MAX_THREAD_TEXT_BYTES), author: principalSchema, createdAt: z.number().int().nonnegative() }).strict();
const capsuleEntrySchema = z.object({ eventId: z.string().regex(safeId), role: z.enum(["user", "assistant"]), text: z.string() }).strict();
const capsuleSchema = z.object({
    version: z.literal(1), kind: z.literal("extractive-context-capsule"), sourceSessionId: z.string().regex(safeId),
    throughEventId: z.string().regex(safeId), sourceDigest: z.string().regex(/^[0-9a-f]{64}$/), createdAt: z.number().int().nonnegative(),
    anchor: capsuleEntrySchema, recentContext: z.array(capsuleEntrySchema).max(MAX_CAPSULE_EVENTS),
    discussion: z.array(z.object({ author: z.string().max(80), text: z.string() }).strict()).max(MAX_THREAD_MESSAGES),
}).strict();
const storedThreadSchema = z.object({
    id: z.uuid(), sourceSessionId: z.string().regex(safeId), anchorEventId: z.string().regex(safeId),
    createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), messages: z.array(messageSchema).max(MAX_THREAD_MESSAGES),
    agentSessionId: z.uuid().nullable(), invokeState: z.enum(["none", "reserved", "started"]), capsule: capsuleSchema.nullable(),
    invokeCommandId: z.string().regex(safeId).nullable(),
}).strict();
const stateSchema = z.object({
    version: z.literal(1), threads: z.array(storedThreadSchema).max(MAX_THREADS),
    commands: z.record(z.string().regex(safeId), z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), threadId: z.uuid() }).strict()),
}).strict();
function statePath(sessionId) {
    return path.join(sessionsDir, sessionId, "message-threads-v1.json");
}
function readState(sessionId) {
    try {
        if (statSync(statePath(sessionId)).size > MAX_THREAD_STATE_BYTES)
            throw new MessageThreadError("THREAD_STORAGE_FULL", "message thread state exceeds its storage limit");
        return stateSchema.parse(JSON.parse(readFileSync(statePath(sessionId), "utf8")));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return empty();
        if (error instanceof MessageThreadError)
            throw error;
        if (error instanceof z.ZodError || error instanceof SyntaxError)
            throw new MessageThreadError("BAD_THREAD", "message thread state is invalid");
        throw error;
    }
}
function writeState(sessionId, state) {
    const dir = path.dirname(statePath(sessionId));
    mkdirSync(dir, { recursive: true });
    const temporary = path.join(dir, `.message-threads-v1.${process.pid}.${randomUUID()}.tmp`);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_THREAD_STATE_BYTES)
        throw new MessageThreadError("THREAD_STORAGE_FULL", "message thread state exceeds its storage limit");
    try {
        writeFileSync(temporary, serialized, { mode: 0o600 });
        renameSync(temporary, statePath(sessionId));
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function view(thread) {
    const { capsule, invokeCommandId: _invokeCommandId, ...safe } = thread;
    return { ...structuredClone(safe), hasCapsule: capsule !== null };
}
function commandReplay(state, commandId, request) {
    const receipt = state.commands[commandId];
    if (!receipt)
        return null;
    if (receipt.hash !== hash(request))
        throw new MessageThreadError("IDEMPOTENCY_CONFLICT", "request id was reused with different thread content");
    const thread = state.threads.find((item) => item.id === receipt.threadId);
    if (!thread)
        throw new Error("message thread idempotency state is corrupt");
    return thread;
}
function textOf(event) {
    const raw = event;
    if (event.type === "user_message" && typeof raw.text === "string")
        return raw.text.trim();
    const message = raw.message && typeof raw.message === "object" ? raw.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.map((part) => part && typeof part === "object" && typeof part.text === "string"
        ? part.text : "").filter(Boolean).join("\n").trim();
}
function roleOf(event) {
    return event.type === "user_message" ? "user" : "assistant";
}
async function transcriptThrough(source, anchorEventId) {
    let entries;
    try {
        // An event may already be visible from the live cache while its ordered
        // JSONL append is still queued. Cross the durability boundary first so a
        // just-rendered anchor is neither spuriously missing nor read from memory
        // through an unbounded fallback.
        await flushTranscript(source.id);
        ({ entries } = await readCommittedTranscriptEntriesBoundedAsync(source.id, source.agent, {
            maxEvents: MAX_TRANSCRIPT_EVENTS, maxSourceBytes: MAX_TRANSCRIPT_SOURCE_BYTES, maxLineBytes: MAX_TRANSCRIPT_LINE_BYTES,
        }));
    }
    catch (error) {
        if (error instanceof CommittedTranscriptLimitError)
            throw new MessageThreadError("TRANSCRIPT_TOO_LARGE", "source transcript exceeds the message-thread read limit");
        throw error;
    }
    const index = entries.findIndex((entry) => entry.id === anchorEventId);
    if (index < 0)
        throw new MessageThreadError("ANCHOR_NOT_FOUND", "thread anchor event was not found");
    if (!isReplyableEvent(entries[index].event))
        throw new MessageThreadError("BAD_THREAD", "thread anchor is not a replyable message");
    const anchorText = textOf(entries[index].event);
    if (!anchorText)
        throw new MessageThreadError("BAD_THREAD", "thread anchor has no replyable text");
    return { entries: entries.slice(0, index + 1), anchor: { eventId: anchorEventId, role: roleOf(entries[index].event), text: anchorText } };
}
function clipUtf8(value, maxBytes) {
    if (Buffer.byteLength(value) <= maxBytes)
        return value;
    let result = "";
    let bytes = 0;
    for (const character of value) {
        const size = Buffer.byteLength(character);
        if (bytes + size > maxBytes)
            break;
        result += character;
        bytes += size;
    }
    return result;
}
async function compileCapsule(source, thread) {
    const { entries, anchor: rawAnchor } = await transcriptThrough(source, thread.anchorEventId);
    const anchor = { ...rawAnchor, text: clipUtf8(rawAnchor.text, MAX_THREAD_TEXT_BYTES) };
    const selected = [];
    let bytes = 0;
    for (let i = entries.length - 1; i >= 0 && selected.length < MAX_CAPSULE_EVENTS; i--) {
        if (!isReplyableEvent(entries[i].event))
            continue;
        const text = textOf(entries[i].event);
        const clipped = clipUtf8(text, 12 * 1024);
        const size = Buffer.byteLength(clipped);
        if (selected.length > 0 && bytes + size > MAX_CAPSULE_SOURCE_BYTES)
            break;
        bytes += size;
        selected.push({ eventId: entries[i].id, role: roleOf(entries[i].event), text: clipped });
    }
    selected.reverse();
    const discussion = [];
    for (let i = thread.messages.length - 1; i >= 0; i--) {
        discussion.unshift({ author: thread.messages[i].author.label, text: thread.messages[i].text });
        const probe = { version: 1, kind: "extractive-context-capsule", sourceSessionId: source.id, throughEventId: thread.anchorEventId, sourceDigest: "0".repeat(64), createdAt: Date.now(), anchor, recentContext: selected, discussion };
        if (Buffer.byteLength(JSON.stringify(probe)) > MAX_CAPSULE_BYTES) {
            discussion.shift();
            break;
        }
    }
    while (selected.length > 1) {
        const probe = { version: 1, kind: "extractive-context-capsule", sourceSessionId: source.id, throughEventId: thread.anchorEventId, sourceDigest: "0".repeat(64), createdAt: Date.now(), anchor, recentContext: selected, discussion };
        if (Buffer.byteLength(JSON.stringify(probe)) <= MAX_CAPSULE_BYTES)
            break;
        selected.shift();
    }
    const sourceDigest = createHash("sha256").update(JSON.stringify({ selected, discussion })).digest("hex");
    return { version: 1, kind: "extractive-context-capsule", sourceSessionId: source.id, throughEventId: thread.anchorEventId, sourceDigest, createdAt: Date.now(), anchor, recentContext: selected, discussion };
}
function validateCommandId(commandId) {
    if (!safeId.test(commandId))
        throw new MessageThreadError("BAD_THREAD", "invalid command id");
}
export function listThreads(sessionId) {
    return readState(sessionId).threads.map(view);
}
/** Compact, read-time metadata attached to source transcript messages. The
 * sidecar remains authoritative; transcript JSONL is never rewritten. */
export function messageThreadAnchors(sessionId) {
    return new Map(readState(sessionId).threads.map((thread) => [thread.anchorEventId, {
            threadId: thread.id,
            messageCount: thread.messages.length,
            activityStatus: thread.invokeState === "started" ? "active" : "discussion",
            updatedAt: thread.updatedAt,
        }]));
}
export function withMessageThreadAnchor(event, eventId, anchors) {
    const messageThread = anchors.get(eventId);
    return messageThread
        ? { ...structuredClone(event), messageThread: structuredClone(messageThread) }
        : structuredClone(event);
}
async function createThreadUnlocked(source, anchorEventId, commandId) {
    validateCommandId(commandId);
    if (!safeId.test(anchorEventId))
        throw new MessageThreadError("BAD_THREAD", "invalid anchor event id");
    const state = readState(source.id);
    const request = { operation: "create", anchorEventId };
    const replay = commandReplay(state, commandId, request);
    if (replay)
        return view(replay);
    const existing = state.threads.find((thread) => thread.anchorEventId === anchorEventId);
    if (existing) {
        state.commands[commandId] = { hash: hash(request), threadId: existing.id };
        writeState(source.id, state);
        return view(existing);
    }
    if (state.threads.length >= MAX_THREADS)
        throw new MessageThreadError("THREAD_STORAGE_FULL", "session has reached the message thread limit");
    await transcriptThrough(source, anchorEventId);
    const now = Date.now();
    const threadId = randomUUID();
    const thread = { id: threadId, sourceSessionId: source.id, anchorEventId, createdAt: now, updatedAt: now, messages: [], capsule: null, agentSessionId: threadId, invokeCommandId: null, invokeState: "none" };
    state.threads.push(thread);
    state.commands[commandId] = { hash: hash(request), threadId: thread.id };
    writeState(source.id, state);
    return view(thread);
}
function appendThreadMessageUnlocked(sessionId, threadId, commandId, text, author) {
    validateCommandId(commandId);
    if (typeof text !== "string")
        throw new MessageThreadError("BAD_THREAD", "thread message text must be a string");
    const normalized = text.trim();
    const parsedAuthor = principalSchema.safeParse(author);
    if (!normalized || Buffer.byteLength(normalized) > MAX_THREAD_TEXT_BYTES || !parsedAuthor.success)
        throw new MessageThreadError("BAD_THREAD", "invalid thread message");
    const state = readState(sessionId);
    const request = { operation: "message", threadId, text: normalized, author: parsedAuthor.data };
    const replay = commandReplay(state, commandId, request);
    if (replay)
        return view(replay);
    const thread = state.threads.find((item) => item.id === threadId);
    if (!thread)
        throw new MessageThreadError("THREAD_NOT_FOUND", "message thread was not found");
    if (thread.invokeState !== "none")
        throw new MessageThreadError("THREAD_INVOKED", "message thread has already moved to its agent session");
    if (thread.messages.length >= MAX_THREAD_MESSAGES)
        throw new MessageThreadError("THREAD_FULL", "message thread is full");
    thread.messages.push({ id: randomUUID(), commandId, text: normalized, author: parsedAuthor.data, createdAt: Date.now() });
    thread.updatedAt = Date.now();
    state.commands[commandId] = { hash: hash(request), threadId };
    writeState(sessionId, state);
    return view(thread);
}
async function invokeThreadUnlocked(source, threadId, commandId, prompt, author, start) {
    validateCommandId(commandId);
    if (prompt !== undefined && typeof prompt !== "string")
        throw new MessageThreadError("BAD_THREAD", "thread invocation prompt must be a string");
    const normalizedPrompt = prompt?.trim() || "Continue this message thread and address its discussion.";
    if (Buffer.byteLength(normalizedPrompt) > MAX_THREAD_TEXT_BYTES)
        throw new MessageThreadError("BAD_THREAD", "thread invocation prompt is too large");
    const state = readState(source.id);
    const request = { operation: "invoke", threadId, prompt: normalizedPrompt };
    const replay = commandReplay(state, commandId, request);
    if (replay?.invokeState === "started")
        return view(replay);
    const thread = state.threads.find((item) => item.id === threadId);
    if (!thread)
        throw new MessageThreadError("THREAD_NOT_FOUND", "message thread was not found");
    if (thread.invokeState === "started")
        return view(thread);
    if (thread.invokeState === "reserved" && thread.invokeCommandId !== commandId) {
        throw new MessageThreadError("IDEMPOTENCY_CONFLICT", "message thread invocation is already reserved by another command");
    }
    const capsule = thread.capsule ?? await compileCapsule(source, thread);
    const agentSessionId = thread.agentSessionId ?? randomUUID();
    // Persist the exact target id and capsule before spawning. If the daemon dies
    // between reservation and start, replay retries the same id instead of
    // creating an unlinked duplicate session.
    thread.capsule = capsule;
    thread.agentSessionId = agentSessionId;
    thread.invokeCommandId = commandId;
    thread.invokeState = "reserved";
    thread.updatedAt = Date.now();
    state.commands[commandId] = { hash: hash(request), threadId };
    writeState(source.id, state);
    start({
        id: thread.agentSessionId,
        prompt: normalizedPrompt,
        title: source.title ? `${source.title} · thread` : "Message thread",
        dir: source.dir,
        projectKey: source.projectKey ?? undefined,
        agent: source.agent,
        model: source.model ?? undefined,
        reasoningEffort: source.reasoningEffort ?? undefined,
        author,
        commandId,
        bootstrapContext: JSON.stringify(capsule),
        threadSource: { sessionId: source.id, threadId, anchorEventId: thread.anchorEventId },
    });
    thread.invokeState = "started";
    thread.updatedAt = Date.now();
    writeState(source.id, state);
    return view(thread);
}
export function createThread(source, anchorEventId, commandId) {
    return withThreadMutation(source.id, () => createThreadUnlocked(source, anchorEventId, commandId));
}
export function appendThreadMessage(sessionId, threadId, commandId, text, author) {
    return withThreadMutation(sessionId, () => appendThreadMessageUnlocked(sessionId, threadId, commandId, text, author));
}
export function invokeThread(source, threadId, commandId, prompt, author, start) {
    return withThreadMutation(source.id, () => invokeThreadUnlocked(source, threadId, commandId, prompt, author, start));
}
