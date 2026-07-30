import { createHash } from "node:crypto";
import { CommittedTranscriptLimitError, flushTranscript, readCommittedTranscriptEntriesBounded, sessions, subscribeTranscriptCommits, } from "./sessions/index.js";
export const TRANSCRIPT_SYNC_CAPABILITY = "transcript-sync-v1";
export const MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES = 192 * 1024;
export const MAX_TRANSCRIPT_SNAPSHOT_EVENTS = 20_000;
export const MAX_TRANSCRIPT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_TRANSCRIPT_CANONICAL_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_TRANSCRIPT_CANONICAL_LINE_BYTES = 16 * 1024 * 1024;
export class TranscriptPublicationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function transcriptEpoch(record) {
    return `te_${createHash("sha256")
        .update(record.id)
        .update("\0")
        .update(String(record.startedAt))
        .digest("base64url")
        .slice(0, 32)}`;
}
function artifactRefs(event, eventId) {
    const refs = [];
    const seen = new Set();
    const visit = (value, key = "", depth = 0) => {
        if (depth > 8 || refs.length >= 32 || value === null || value === undefined)
            return;
        if (typeof value === "string") {
            if ((key === "path" || key === "logPath") && value && Buffer.byteLength(value) <= 4_096) {
                refs.push({ kind: key === "logPath" ? "log" : "file", path: value });
            }
            return;
        }
        if (typeof value !== "object" || seen.has(value))
            return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value.slice(0, 128))
                visit(item, key, depth + 1);
            return;
        }
        for (const [childKey, child] of Object.entries(value)) {
            visit(child, childKey, depth + 1);
        }
    };
    visit(event);
    if (refs.length === 0 && Buffer.byteLength(JSON.stringify(event)) > MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES) {
        refs.push({ kind: "session_transcript_event", eventId });
    }
    return refs;
}
function boundedClone(value, stringBytes, arrayItems, depth = 0) {
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const bytes = Buffer.from(value);
        if (bytes.length <= stringBytes)
            return value;
        let end = stringBytes;
        while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80)
            end -= 1;
        return `${bytes.subarray(0, end).toString("utf8")}\n[reverse WSS payload truncated]`;
    }
    if (depth >= 12)
        return "[reverse WSS nesting truncated]";
    if (Array.isArray(value)) {
        const kept = value.slice(0, arrayItems).map((item) => boundedClone(item, stringBytes, arrayItems, depth + 1));
        if (value.length > arrayItems)
            kept.push(`[${value.length - arrayItems} items omitted]`);
        return kept;
    }
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .slice(0, 256)
            .map(([key, item]) => [key, boundedClone(item, stringBytes, arrayItems, depth + 1)]));
    }
    return String(value);
}
function boundedString(value, maxBytes) {
    if (value === null)
        return null;
    return boundedClone(value, maxBytes, 1);
}
function boundedArtifactRefs(refs, maxItems, maxPathBytes) {
    return refs.slice(0, maxItems).map((ref) => ({
        kind: boundedString(ref.kind, 128) ?? "artifact",
        ...(ref.path ? { path: boundedString(ref.path, maxPathBytes) ?? undefined } : {}),
        ...(ref.eventId ? { eventId: boundedString(ref.eventId, 256) ?? undefined } : {}),
    }));
}
function transcriptPriority(event) {
    return event.eventType === "result" ? "critical" : event.eventType === "warning" ? "control" : "normal";
}
export function transcriptLiveEventFrame(event) {
    return { type: "transcript_live_event", ...event };
}
/**
 * Count the complete durable frame, not only its payload. The placeholder
 * identifiers have the exact maximum lengths produced by Peon's outbox.
 */
export function transcriptDurableEnvelopeBytes(event) {
    return Buffer.byteLength(JSON.stringify({
        type: "durable_message",
        epoch: "00000000-0000-0000-0000-000000000000",
        cursor: "___________",
        messageId: "00000000-0000-0000-0000-000000000000",
        priority: transcriptPriority(event),
        capability: TRANSCRIPT_SYNC_CAPABILITY,
        payload: transcriptLiveEventFrame(event),
    }));
}
function stabilizeRetainedBytes(event) {
    if (!event.truncation)
        return event;
    let result = event;
    for (let iteration = 0; iteration < 4; iteration += 1) {
        const retainedBytes = transcriptDurableEnvelopeBytes(result);
        const truncation = result.truncation;
        if (!truncation || truncation.retainedBytes === retainedBytes)
            break;
        result = {
            ...result,
            truncation: { ...truncation, retainedBytes },
        };
    }
    return result;
}
export function publishedTranscriptEvent(sessionId, epoch, seq, entry) {
    const original = entry.event;
    const usage = original.usage && typeof original.usage === "object" && !Array.isArray(original.usage)
        ? structuredClone(original.usage)
        : null;
    const author = typeof original.author === "string" ? original.author : null;
    const refs = artifactRefs(original, entry.id);
    const exact = {
        sessionId,
        epoch,
        revision: seq,
        seq,
        eventId: entry.id,
        createdAt: typeof original.createdAt === "number" ? original.createdAt : null,
        eventType: original.type,
        author,
        usage,
        event: structuredClone(original),
        artifactRefs: refs,
    };
    const originalBytes = transcriptDurableEnvelopeBytes(exact);
    if (originalBytes <= MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES)
        return exact;
    const canonicalRef = { kind: "session_transcript_event", eventId: entry.id };
    const levels = [
        { stringBytes: 32 * 1024, arrayItems: 128, usageBytes: 8 * 1024, usageItems: 64, authorBytes: 4 * 1024, refItems: 32, refBytes: 4 * 1024 },
        { stringBytes: 8 * 1024, arrayItems: 64, usageBytes: 2 * 1024, usageItems: 32, authorBytes: 1 * 1024, refItems: 16, refBytes: 2 * 1024 },
        { stringBytes: 2 * 1024, arrayItems: 32, usageBytes: 512, usageItems: 16, authorBytes: 512, refItems: 8, refBytes: 512 },
        { stringBytes: 512, arrayItems: 16, usageBytes: 128, usageItems: 8, authorBytes: 256, refItems: 4, refBytes: 256 },
    ];
    for (const level of levels) {
        const boundedRefs = boundedArtifactRefs(refs, level.refItems, level.refBytes);
        if (!boundedRefs.some((ref) => ref.kind === canonicalRef.kind && ref.eventId === canonicalRef.eventId)) {
            boundedRefs.push(canonicalRef);
        }
        const candidate = stabilizeRetainedBytes({
            ...exact,
            author: boundedString(author, level.authorBytes),
            usage: usage ? boundedClone(usage, level.usageBytes, level.usageItems) : null,
            event: boundedClone(original, level.stringBytes, level.arrayItems),
            artifactRefs: boundedRefs,
            truncation: {
                transport: "reverse-wss",
                originalBytes,
                retainedBytes: 0,
                artifact: { kind: "session_transcript_event", sessionId, eventId: entry.id },
            },
        });
        if (transcriptDurableEnvelopeBytes(candidate) <= MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES)
            return candidate;
    }
    const minimal = stabilizeRetainedBytes({
        ...exact,
        author: boundedString(author, 128),
        usage: null,
        event: {
            type: original.type,
            ...(typeof original.createdAt === "number" ? { createdAt: original.createdAt } : {}),
            transportTruncated: true,
        },
        artifactRefs: [canonicalRef],
        truncation: {
            transport: "reverse-wss",
            originalBytes,
            retainedBytes: 0,
            artifact: { kind: "session_transcript_event", sessionId, eventId: entry.id },
        },
    });
    if (transcriptDurableEnvelopeBytes(minimal) > MAX_PUBLISHED_TRANSCRIPT_EVENT_BYTES) {
        throw new TranscriptPublicationError("TRANSCRIPT_UNAVAILABLE", "canonical transcript event cannot fit the reverse wire budget");
    }
    return minimal;
}
export class TranscriptPublicationRepository {
    source;
    readCommitted;
    flush;
    subscribeCommits;
    maxSnapshotEvents;
    maxSnapshotBytes;
    readLimits;
    slots = new Map();
    listeners = new Set();
    unsubscribeCommits = null;
    started = false;
    constructor(options = {}) {
        this.source = options.source ?? sessions;
        this.maxSnapshotEvents = options.maxSnapshotEvents ?? MAX_TRANSCRIPT_SNAPSHOT_EVENTS;
        this.maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_TRANSCRIPT_SNAPSHOT_BYTES;
        this.readLimits = {
            maxEvents: this.maxSnapshotEvents,
            maxSourceBytes: options.maxCanonicalSourceBytes ?? MAX_TRANSCRIPT_CANONICAL_SOURCE_BYTES,
            maxLineBytes: options.maxCanonicalLineBytes ?? MAX_TRANSCRIPT_CANONICAL_LINE_BYTES,
        };
        this.readCommitted = options.readCommitted
            ?? ((sessionId, agent, limits) => readCommittedTranscriptEntriesBounded(sessionId, agent, limits));
        this.flush = options.flush ?? flushTranscript;
        this.subscribeCommits = options.subscribeCommits ?? subscribeTranscriptCommits;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.unsubscribeCommits = this.subscribeCommits?.((payload) => this.committed(payload.sessionId, payload.entry)) ?? null;
        this.source.on("delete", this.deleted);
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.unsubscribeCommits?.();
        this.unsubscribeCommits = null;
        this.source.off("delete", this.deleted);
        this.slots.clear();
    }
    subscribe(listener) {
        this.start();
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async state(sessionId) {
        this.start();
        const existing = this.slots.get(sessionId);
        if (existing)
            return existing.state ?? existing.loading;
        const record = this.source.get(sessionId);
        if (!record)
            throw new TranscriptPublicationError("UNKNOWN_SESSION", "session does not exist");
        let resolveLoading;
        let rejectLoading;
        const loading = new Promise((resolve, reject) => {
            resolveLoading = resolve;
            rejectLoading = reject;
        });
        const slot = { state: null, pending: [], loading };
        this.slots.set(sessionId, slot);
        void this.load(record, slot).then(resolveLoading, (error) => {
            if (this.slots.get(sessionId) === slot)
                this.slots.delete(sessionId);
            rejectLoading(error);
        });
        return loading;
    }
    release(sessionId) {
        this.slots.delete(sessionId);
    }
    async load(record, slot) {
        try {
            await this.flush(record.id);
        }
        catch {
            // The JSONL file is the authority. A failed queued append or sidecar
            // update must not turn already-committed history into provider rebuilds.
        }
        if (!this.source.get(record.id))
            throw new TranscriptPublicationError("UNKNOWN_SESSION", "session does not exist");
        let entries;
        try {
            const read = await this.readCommitted(record.id, record.agent, this.readLimits);
            entries = Array.isArray(read) ? read : read.entries;
        }
        catch (error) {
            if (error instanceof CommittedTranscriptLimitError) {
                throw new TranscriptPublicationError("SNAPSHOT_TOO_LARGE", error.message);
            }
            throw new TranscriptPublicationError("TRANSCRIPT_UNAVAILABLE", "canonical transcript could not be read");
        }
        if (entries.length > this.maxSnapshotEvents) {
            throw new TranscriptPublicationError("SNAPSHOT_TOO_LARGE", "canonical transcript exceeds event limit");
        }
        const seen = new Set(entries.map((entry) => entry.id));
        for (const entry of slot.pending) {
            if (!seen.has(entry.id)) {
                if (entries.length >= this.maxSnapshotEvents) {
                    throw new TranscriptPublicationError("SNAPSHOT_TOO_LARGE", "canonical transcript exceeds event limit");
                }
                entries.push(entry);
                seen.add(entry.id);
            }
        }
        const epoch = transcriptEpoch(record);
        const published = [];
        let publishedBytes = 2;
        for (const [index, entry] of entries.entries()) {
            const event = publishedTranscriptEvent(record.id, epoch, index + 1, entry);
            const eventBytes = Buffer.byteLength(JSON.stringify(event));
            const nextBytes = publishedBytes + eventBytes + (published.length > 0 ? 1 : 0);
            if (nextBytes > this.maxSnapshotBytes) {
                throw new TranscriptPublicationError("SNAPSHOT_TOO_LARGE", "canonical transcript exceeds snapshot byte limit");
            }
            published.push(event);
            publishedBytes = nextBytes;
        }
        const state = {
            sessionId: record.id,
            epoch,
            revision: published.length,
            bytes: publishedBytes,
            entries: published,
        };
        slot.pending = [];
        slot.state = state;
        return state;
    }
    committed(sessionId, entry) {
        const slot = this.slots.get(sessionId);
        if (!slot)
            return;
        if (!slot.state) {
            slot.pending.push(entry);
            return;
        }
        if (slot.state.entries.some((candidate) => candidate.eventId === entry.id))
            return;
        const seq = slot.state.revision + 1;
        const event = publishedTranscriptEvent(sessionId, slot.state.epoch, seq, entry);
        const nextBytes = slot.state.bytes + Buffer.byteLength(JSON.stringify(event)) + (slot.state.entries.length > 0 ? 1 : 0);
        if (seq > this.maxSnapshotEvents || nextBytes > this.maxSnapshotBytes) {
            this.publish({ type: "resync", sessionId, reason: "canonical transcript exceeded snapshot retention bounds" });
            this.slots.delete(sessionId);
            return;
        }
        slot.state.entries.push(event);
        slot.state.revision = seq;
        slot.state.bytes = nextBytes;
        this.publish({ type: "event", event });
    }
    deleted = (sessionId) => {
        const slot = this.slots.get(sessionId);
        if (!slot?.state) {
            this.slots.delete(sessionId);
            return;
        }
        this.publish({
            type: "deleted",
            sessionId,
            epoch: slot.state.epoch,
            revision: slot.state.revision,
        });
        this.slots.delete(sessionId);
    };
    publish(update) {
        for (const listener of this.listeners) {
            try {
                listener(structuredClone(update));
            }
            catch (error) {
                console.error(`transcript publication listener failed for session ${update.type === "event" ? update.event.sessionId : update.sessionId}: `
                    + `${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}
export const transcriptPublication = new TranscriptPublicationRepository();
