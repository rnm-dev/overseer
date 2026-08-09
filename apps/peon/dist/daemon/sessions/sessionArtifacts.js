import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeStoredAgentEvent } from "../agents/index.js";
import { stateDir } from "../runtime/xdgPaths.js";
import { decodeTranscriptCursor, encodeIndexedTranscriptCursor, TranscriptPaginationError, } from "./transcriptPagination.js";
// Cohesion note: this file is the current transcript/session-artifact
// repository boundary. The index lifecycle intentionally lives beside the
// authoritative JSONL append queue so append, page read, deletion, and crash
// recovery share one ordering invariant. The planned sessions-module split in
// docs/architecture.md can move this boundary as a unit later.
export const sessionsDir = path.join(stateDir(), "sessions");
const TRANSCRIPT_EVENT_ID_FIELD = "_peonEventId";
const SAFE_TRANSCRIPT_EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/;
const transcriptCache = new Map();
const appendQueues = new Map();
const appendErrors = new Map();
const discardedTranscripts = new Set();
const transcriptCommitListeners = new Set();
const TRANSCRIPT_INDEX_VERSION = 1;
const TRANSCRIPT_INDEX_READ_CHUNK = 64 * 1024;
const TRANSCRIPT_INDEX_CACHE_LIMIT = 256;
let transcriptReadObserver = null;
const warmTranscriptIndexes = new Map();
export function observeTranscriptReads(observer) {
    transcriptReadObserver = observer;
}
/**
 * Subscribe at the canonical durability boundary. Unlike the existing live
 * session emitter, this fires only after the JSONL row has been appended.
 * Listener failures cannot make an already-durable transcript append fail.
 */
export function subscribeTranscriptCommits(listener) {
    transcriptCommitListeners.add(listener);
    return () => transcriptCommitListeners.delete(listener);
}
function publishTranscriptCommit(sessionId, entry) {
    for (const listener of transcriptCommitListeners) {
        try {
            listener({ sessionId, entry: structuredClone(entry) });
        }
        catch (error) {
            // Transcript bodies are deliberately excluded from routine logs.
            console.error(`transcript commit listener failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
export function summaryPath(id) {
    return path.join(sessionsDir, `${id}.summary.json`);
}
export function transcriptPath(id) {
    return path.join(sessionsDir, `${id}.jsonl`);
}
export function transcriptIndexPath(id) {
    return path.join(sessionsDir, `${id}.jsonl.idx`);
}
export function transcriptIndexMetaPath(id) {
    return path.join(sessionsDir, `${id}.jsonl.idx.meta.json`);
}
export function attachmentsDir(id) {
    return path.join(sessionsDir, id, "attachments");
}
/**
 * Logical byte size of every persisted session artifact, grouped without
 * opening file contents. Top-level <id>.summary.json, <id>.jsonl, and <id>/
 * entries all belong to the same durable session id. Unknown top-level files
 * remain in totalBytes but intentionally have no bySessionId entry.
 */
export function sessionArtifactInventory(root = sessionsDir) {
    function sizeOf(target) {
        let stat;
        try {
            stat = lstatSync(target);
        }
        catch {
            // Stats are observational and must remain available if an artifact is
            // concurrently deleted or temporarily unreadable.
            return 0;
        }
        if (stat.isFile())
            return stat.size;
        if (!stat.isDirectory())
            return 0;
        let entries;
        try {
            entries = readdirSync(target);
        }
        catch {
            return 0;
        }
        return entries.reduce((total, entry) => total + sizeOf(path.join(target, entry)), 0);
    }
    const bySessionId = new Map();
    let totalBytes = 0;
    let entries;
    try {
        entries = readdirSync(root);
    }
    catch {
        return { totalBytes: 0, bySessionId };
    }
    for (const entry of entries) {
        const bytes = sizeOf(path.join(root, entry));
        totalBytes += bytes;
        const id = entry.endsWith(".summary.json")
            ? entry.slice(0, -".summary.json".length)
            : entry.endsWith(".jsonl.idx.meta.json")
                ? entry.slice(0, -".jsonl.idx.meta.json".length)
                : entry.endsWith(".jsonl.idx")
                    ? entry.slice(0, -".jsonl.idx".length)
                    : entry.endsWith(".jsonl")
                        ? entry.slice(0, -".jsonl".length)
                        : (() => {
                            try {
                                return lstatSync(path.join(root, entry)).isDirectory() ? entry : null;
                            }
                            catch {
                                return null;
                            }
                        })();
        if (id)
            bySessionId.set(id, (bySessionId.get(id) ?? 0) + bytes);
    }
    return { totalBytes, bySessionId };
}
/** Logical byte size of every persisted session artifact, including orphans. */
export function sessionsSizeBytes() {
    return sessionArtifactInventory().totalBytes;
}
export function persistSummary(record) {
    mkdirSync(sessionsDir, { recursive: true });
    const target = summaryPath(record.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        // A daemon can briefly overlap its replacement during a development
        // restart. Writing directly to the shared summary path lets those two
        // processes truncate and interleave one another's JSON. A same-directory
        // rename is atomic, so readers see either complete version, never a
        // partially written combination of both.
        writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
        renameSync(temporary, target);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
export function appendTranscriptEvent(id, event, now = Date.now, preservedEventId) {
    // Stamp at the commit boundary so persisted history, transcript snapshots,
    // and the live SSE event all carry the same Peon-authored receive time.
    const committedEvent = { ...structuredClone(event), createdAt: now() };
    // Branches copy Peon's canonical transcript, including event identity. That
    // keeps a copied user_message.replyTo.eventId resolvable inside the branch.
    // Normal appends always mint a new ID; never accept an unsafe persisted ID.
    const entry = { id: preservedEventId && SAFE_TRANSCRIPT_EVENT_ID.test(preservedEventId) ? preservedEventId : randomUUID(), event: committedEvent };
    const cached = transcriptCache.get(id);
    if (cached)
        cached.push(entry);
    else
        transcriptCache.set(id, [entry]);
    const previous = appendQueues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(async () => {
        if (discardedTranscripts.has(id))
            return;
        await mkdir(sessionsDir, { recursive: true });
        if (discardedTranscripts.has(id))
            return;
        const file = transcriptPath(id);
        const row = `${JSON.stringify({ ...committedEvent, [TRANSCRIPT_EVENT_ID_FIELD]: entry.id })}\n`;
        let beforeBytes = 0;
        let beforeMtimeMs = 0;
        let needsSeparator = false;
        try {
            const beforeStat = await stat(file);
            beforeBytes = beforeStat.size;
            beforeMtimeMs = beforeStat.mtimeMs;
            if (beforeBytes > 0) {
                const handle = await open(file, "r");
                try {
                    const finalByte = Buffer.alloc(1);
                    await handle.read(finalByte, 0, 1, beforeBytes - 1);
                    needsSeparator = finalByte[0] !== 0x0a;
                }
                finally {
                    await handle.close();
                }
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        // A crash may leave a partial final JSONL row. Terminate that corrupt
        // physical row before committing the next event so the valid append never
        // becomes part of the malformed payload and disappear after restart.
        await appendFile(file, `${needsSeparator ? "\n" : ""}${row}`);
        publishTranscriptCommit(id, entry);
        if (!needsSeparator)
            await appendTranscriptIndexRecord(id, beforeBytes, beforeMtimeMs, Buffer.byteLength(row) - 1, entry.id);
    });
    appendQueues.set(id, next);
    next.catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        appendErrors.set(id, err);
        console.error(`failed to persist transcript for session ${id}: ${err.message}`);
    });
    return entry;
}
function legacyEventId(sessionId, line, lineNumber) {
    return `legacy_${createHash("sha256").update(sessionId).update("\0").update(String(lineNumber)).update("\0").update(line).digest("base64url")}`;
}
async function readIndexMeta(id) {
    try {
        const parsed = JSON.parse(await readFile(transcriptIndexMetaPath(id), "utf8"));
        if (parsed.version !== TRANSCRIPT_INDEX_VERSION ||
            !Number.isSafeInteger(parsed.transcriptBytes) || parsed.transcriptBytes < 0 ||
            typeof parsed.transcriptMtimeMs !== "number" ||
            !Number.isSafeInteger(parsed.indexBytes) || parsed.indexBytes < 0 ||
            !Number.isSafeInteger(parsed.rows) || parsed.rows < 0 ||
            typeof parsed.completeFinalLine !== "boolean")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
async function writeIndexMeta(id, meta) {
    const target = transcriptIndexMetaPath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(meta), { mode: 0o600 });
        await rename(temporary, target);
    }
    finally {
        await rm(temporary, { force: true });
    }
}
function encodeIndexRecord(record) {
    return `${JSON.stringify(record)}\n`;
}
async function appendTranscriptIndexRecord(id, offset, previousMtimeMs, length, eventId) {
    const fileStat = await stat(transcriptPath(id));
    let meta = await readIndexMeta(id);
    if (!meta && offset === 0) {
        await writeFile(transcriptIndexPath(id), "", { mode: 0o600 });
        meta = {
            version: TRANSCRIPT_INDEX_VERSION,
            transcriptBytes: 0,
            transcriptMtimeMs: 0,
            indexBytes: 0,
            rows: 0,
            completeFinalLine: true,
        };
    }
    // A missing/stale sidecar is rebuilt by the first paginated read. Never
    // append a plausible-looking record to an index whose transcript boundary
    // is unknown, because that could make an older committed row disappear.
    if (!meta ||
        meta.transcriptBytes !== offset ||
        (offset > 0 && meta.transcriptMtimeMs !== previousMtimeMs) ||
        !meta.completeFinalLine)
        return;
    const encoded = encodeIndexRecord({
        version: TRANSCRIPT_INDEX_VERSION,
        transcriptOffset: offset,
        transcriptLength: length,
        lineNumber: meta.rows,
        eventId,
    });
    await appendFile(transcriptIndexPath(id), encoded);
    await writeIndexMeta(id, {
        version: TRANSCRIPT_INDEX_VERSION,
        transcriptBytes: fileStat.size,
        transcriptMtimeMs: fileStat.mtimeMs,
        indexBytes: meta.indexBytes + Buffer.byteLength(encoded),
        rows: meta.rows + 1,
        completeFinalLine: true,
    });
}
function indexRecordForLine(sessionId, agent, lineBytes, transcriptOffset, transcriptLength, lineNumber, seen) {
    const line = lineBytes.toString("utf8");
    let eventId = null;
    if (line) {
        try {
            const raw = JSON.parse(line);
            const { [TRANSCRIPT_EVENT_ID_FIELD]: _persistedEventId, ...eventFields } = raw;
            if (normalizeStoredAgentEvent(agent, eventFields)) {
                const persistedId = typeof raw[TRANSCRIPT_EVENT_ID_FIELD] === "string" && SAFE_TRANSCRIPT_EVENT_ID.test(raw[TRANSCRIPT_EVENT_ID_FIELD])
                    ? raw[TRANSCRIPT_EVENT_ID_FIELD]
                    : null;
                const fallback = legacyEventId(sessionId, line, lineNumber);
                eventId = persistedId ?? fallback;
                for (let duplicate = 1; seen.has(eventId); duplicate += 1)
                    eventId = `${fallback}_${duplicate}`;
                seen.add(eventId);
            }
        }
        catch {
            // Invalid physical rows remain indexed with a null event id. Retaining
            // their line number is what keeps later legacy event identities stable.
        }
    }
    return { version: TRANSCRIPT_INDEX_VERSION, transcriptOffset, transcriptLength, lineNumber, eventId };
}
async function rebuildTranscriptIndex(id, agent) {
    const file = transcriptPath(id);
    const before = await stat(file);
    const target = transcriptIndexPath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        const output = await open(temporary, "w", 0o600);
        const seen = new Set();
        let carry = Buffer.alloc(0);
        let transcriptOffset = 0;
        let lineNumber = 0;
        let indexBytes = 0;
        let outputBatch = "";
        let outputBatchBytes = 0;
        const emit = async (lineBytes, length) => {
            const encoded = encodeIndexRecord(indexRecordForLine(id, agent, lineBytes, transcriptOffset, length, lineNumber, seen));
            const encodedBytes = Buffer.byteLength(encoded);
            outputBatch += encoded;
            outputBatchBytes += encodedBytes;
            indexBytes += encodedBytes;
            transcriptOffset += length;
            lineNumber += 1;
            if (outputBatchBytes >= TRANSCRIPT_INDEX_READ_CHUNK) {
                await output.write(outputBatch);
                outputBatch = "";
                outputBatchBytes = 0;
            }
        };
        try {
            for await (const rawChunk of createReadStream(file, { highWaterMark: TRANSCRIPT_INDEX_READ_CHUNK })) {
                const chunk = carry.length > 0 ? Buffer.concat([carry, rawChunk]) : rawChunk;
                let start = 0;
                for (;;) {
                    const newline = chunk.indexOf(0x0a, start);
                    if (newline < 0)
                        break;
                    const content = chunk.subarray(start, newline);
                    await emit(content, content.length + 1);
                    start = newline + 1;
                }
                carry = Buffer.from(chunk.subarray(start));
            }
            if (carry.length > 0)
                await emit(carry, carry.length);
            if (outputBatch)
                await output.write(outputBatch);
            await output.sync();
        }
        finally {
            await output.close();
        }
        const after = await stat(file);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            throw new Error("transcript changed while its index was being rebuilt");
        }
        await rename(temporary, target);
        const meta = {
            version: TRANSCRIPT_INDEX_VERSION,
            transcriptBytes: after.size,
            transcriptMtimeMs: after.mtimeMs,
            indexBytes,
            rows: lineNumber,
            completeFinalLine: after.size === 0 || carry.length === 0,
        };
        await writeIndexMeta(id, meta);
        return meta;
    }
    finally {
        await rm(temporary, { force: true });
    }
}
async function validTranscriptIndex(id) {
    const meta = await readIndexMeta(id);
    if (!meta)
        return null;
    try {
        const [transcriptStat, indexStat] = await Promise.all([stat(transcriptPath(id)), stat(transcriptIndexPath(id))]);
        if (transcriptStat.size !== meta.transcriptBytes ||
            transcriptStat.mtimeMs !== meta.transcriptMtimeMs ||
            indexStat.size !== meta.indexBytes)
            return null;
        return meta;
    }
    catch {
        return null;
    }
}
async function ensureTranscriptIndex(id, agent) {
    const valid = await validTranscriptIndex(id);
    if (valid)
        return { meta: valid, rebuilt: false, recovered: false };
    const recovered = existsSync(transcriptIndexPath(id)) || existsSync(transcriptIndexMetaPath(id));
    return { meta: await rebuildTranscriptIndex(id, agent), rebuilt: true, recovered };
}
function parseTranscriptLine(id, agent, line, lineNumber, seen) {
    if (!line)
        return null;
    try {
        const raw = JSON.parse(line);
        const { [TRANSCRIPT_EVENT_ID_FIELD]: _persistedEventId, ...eventFields } = raw;
        const event = normalizeStoredAgentEvent(agent, eventFields);
        if (!event)
            return null;
        const persistedId = typeof raw[TRANSCRIPT_EVENT_ID_FIELD] === "string" && SAFE_TRANSCRIPT_EVENT_ID.test(raw[TRANSCRIPT_EVENT_ID_FIELD])
            ? raw[TRANSCRIPT_EVENT_ID_FIELD]
            : null;
        const candidate = persistedId ?? legacyEventId(id, line, lineNumber);
        // A copied JSONL row must not make two distinct positions share an id.
        const fallback = legacyEventId(id, line, lineNumber);
        let eventId = candidate;
        for (let duplicate = 1; seen.has(eventId); duplicate += 1) {
            eventId = `${fallback}_${duplicate}`;
        }
        seen.add(eventId);
        return { id: eventId, event };
    }
    catch {
        // A malformed historical/partial row is invisible but does not make the
        // remaining durable identities shift: legacy ids include physical line.
        return null;
    }
}
function readTranscriptEntriesFromDisk(id, agent) {
    const file = transcriptPath(id);
    if (!existsSync(file))
        return [];
    const entries = [];
    const seen = new Set();
    for (const [lineNumber, line] of readFileSync(file, "utf8").split("\n").entries()) {
        const entry = parseTranscriptLine(id, agent, line, lineNumber, seen);
        if (entry)
            entries.push(entry);
    }
    return entries;
}
export class CommittedTranscriptLimitError extends Error {
    limit;
    constructor(limit) {
        super(`canonical transcript exceeds ${limit.replaceAll("_", " ")} limit`);
        this.limit = limit;
    }
}
/**
 * Read only rows which crossed the JSONL append boundary. The normal transcript
 * reader intentionally includes accepted-but-not-yet-flushed cache entries;
 * reverse publication must not expose those as durable history.
 */
export function readCommittedTranscriptEntries(id, agent) {
    return readTranscriptEntriesFromDisk(id, agent).map((entry) => ({ ...entry }));
}
/**
 * Stream the canonical JSONL through fixed buffers for reverse publication.
 * Bounds are enforced while bytes and physical lines are read, before the
 * complete transcript can be materialized in memory.
 */
export function readCommittedTranscriptEntriesBounded(id, agent, limits) {
    const file = transcriptPath(id);
    if (!existsSync(file))
        return { entries: [], sourceBytes: 0 };
    const handle = openSync(file, "r");
    const entries = [];
    const seen = new Set();
    const chunk = Buffer.alloc(64 * 1024);
    let carry = Buffer.alloc(0);
    let sourceBytes = 0;
    let lineNumber = 0;
    const accept = (lineBytes) => {
        if (lineBytes.length > limits.maxLineBytes)
            throw new CommittedTranscriptLimitError("line_bytes");
        const entry = parseTranscriptLine(id, agent, lineBytes.toString("utf8"), lineNumber, seen);
        lineNumber += 1;
        if (!entry)
            return;
        if (entries.length >= limits.maxEvents)
            throw new CommittedTranscriptLimitError("events");
        entries.push(entry);
    };
    try {
        for (;;) {
            const bytesRead = readSync(handle, chunk, 0, chunk.length, null);
            if (bytesRead === 0)
                break;
            sourceBytes += bytesRead;
            if (sourceBytes > limits.maxSourceBytes)
                throw new CommittedTranscriptLimitError("source_bytes");
            const combined = carry.length > 0
                ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
                : Buffer.from(chunk.subarray(0, bytesRead));
            let start = 0;
            for (;;) {
                const newline = combined.indexOf(0x0a, start);
                if (newline < 0)
                    break;
                accept(combined.subarray(start, newline));
                start = newline + 1;
            }
            carry = Buffer.from(combined.subarray(start));
            if (carry.length > limits.maxLineBytes)
                throw new CommittedTranscriptLimitError("line_bytes");
        }
        if (carry.length > 0)
            accept(carry);
        return { entries, sourceBytes };
    }
    finally {
        closeSync(handle);
    }
}
export function readTranscriptEntries(id, agent) {
    const cached = transcriptCache.get(id);
    if (cached)
        return cached.map((entry) => ({ ...entry }));
    const entries = readTranscriptEntriesFromDisk(id, agent);
    transcriptCache.set(id, entries);
    return entries.map((entry) => ({ ...entry }));
}
export function readTranscript(id, agent) {
    return readTranscriptEntries(id, agent).map((entry) => entry.event);
}
async function indexLineAt(handle, offset) {
    let position = offset;
    const chunks = [];
    let examined = 0;
    for (;;) {
        const chunk = Buffer.alloc(TRANSCRIPT_INDEX_READ_CHUNK);
        const result = await handle.read(chunk, 0, chunk.length, position);
        examined += result.bytesRead;
        if (result.bytesRead === 0)
            return chunks.length > 0
                ? { line: Buffer.concat(chunks).toString("utf8"), bytesExamined: examined }
                : null;
        const data = chunk.subarray(0, result.bytesRead);
        const newline = data.indexOf(0x0a);
        if (newline >= 0) {
            chunks.push(data.subarray(0, newline));
            return { line: Buffer.concat(chunks).toString("utf8"), bytesExamined: examined };
        }
        chunks.push(data);
        position += data.length;
    }
}
async function isIndexRecordBoundary(handle, offset) {
    if (offset === 0)
        return true;
    const byte = Buffer.alloc(1);
    const result = await handle.read(byte, 0, 1, offset - 1);
    return result.bytesRead === 1 && byte[0] === 0x0a;
}
function parseIndexRecord(line) {
    let candidate;
    try {
        candidate = JSON.parse(line);
    }
    catch {
        throw new Error("transcript index contains malformed JSON");
    }
    if (candidate.version !== TRANSCRIPT_INDEX_VERSION ||
        !Number.isSafeInteger(candidate.transcriptOffset) || candidate.transcriptOffset < 0 ||
        !Number.isSafeInteger(candidate.transcriptLength) || candidate.transcriptLength < 0 ||
        !Number.isSafeInteger(candidate.lineNumber) || candidate.lineNumber < 0 ||
        !(candidate.eventId === null || (typeof candidate.eventId === "string" && SAFE_TRANSCRIPT_EVENT_ID.test(candidate.eventId))))
        throw new Error("transcript index contains an invalid record");
    return candidate;
}
async function collectIndexRecordsBackward(id, end, count, metrics) {
    const records = [];
    const handle = await open(transcriptIndexPath(id), "r");
    let position = end;
    let suffix = Buffer.alloc(0);
    try {
        while (position > 0 && records.length < count) {
            const start = Math.max(0, position - TRANSCRIPT_INDEX_READ_CHUNK);
            const block = Buffer.alloc(position - start);
            const result = await handle.read(block, 0, block.length, start);
            metrics.indexBytesExamined += result.bytesRead;
            const data = block.subarray(0, result.bytesRead);
            const combined = suffix.length > 0 ? Buffer.concat([data, suffix]) : data;
            let lineEnd = combined.length;
            if (lineEnd > 0 && combined[lineEnd - 1] === 0x0a)
                lineEnd -= 1;
            while (lineEnd > 0 && records.length < count) {
                const newline = combined.lastIndexOf(0x0a, lineEnd - 1);
                if (newline < 0)
                    break;
                const record = parseIndexRecord(combined.subarray(newline + 1, lineEnd).toString("utf8"));
                if (record.eventId !== null)
                    records.push({ indexOffset: start + newline + 1, record });
                lineEnd = newline;
            }
            suffix = Buffer.from(combined.subarray(0, lineEnd));
            position = start;
        }
        if (position === 0 && suffix.length > 0 && records.length < count) {
            const record = parseIndexRecord(suffix.toString("utf8"));
            if (record.eventId !== null)
                records.push({ indexOffset: 0, record });
        }
        return records;
    }
    finally {
        await handle.close();
    }
}
async function locateIndexEvent(id, eventId, metrics) {
    let carry = Buffer.alloc(0);
    let offset = 0;
    for await (const rawChunk of createReadStream(transcriptIndexPath(id), { highWaterMark: TRANSCRIPT_INDEX_READ_CHUNK })) {
        const source = rawChunk;
        metrics.indexBytesExamined += source.length;
        const chunk = carry.length > 0 ? Buffer.concat([carry, source]) : source;
        let start = 0;
        for (;;) {
            const newline = chunk.indexOf(0x0a, start);
            if (newline < 0)
                break;
            const line = chunk.subarray(start, newline).toString("utf8");
            const recordOffset = offset - carry.length + start;
            if (parseIndexRecord(line).eventId === eventId)
                return recordOffset;
            start = newline + 1;
        }
        offset += source.length;
        carry = Buffer.from(chunk.subarray(start));
    }
    if (carry.length > 0 && parseIndexRecord(carry.toString("utf8")).eventId === eventId)
        return offset - carry.length;
    return null;
}
async function readIndexedTranscriptPage(id, agent, meta, cursorOptions, metrics) {
    let end = meta.indexBytes;
    if (cursorOptions.cursor) {
        const cursor = decodeTranscriptCursor(cursorOptions.cursor, id);
        const indexedOffset = cursor.beforeIndexOffset;
        end = indexedOffset ?? await locateIndexEvent(id, cursor.beforeEventId, metrics) ?? -1;
        if (end < 0 || end > meta.indexBytes) {
            throw new TranscriptPaginationError("BAD_CURSOR", "transcript cursor is no longer available");
        }
        const indexHandle = await open(transcriptIndexPath(id), "r");
        try {
            if (indexedOffset !== undefined && !await isIndexRecordBoundary(indexHandle, end)) {
                throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
            }
            const line = await indexLineAt(indexHandle, end);
            metrics.indexBytesExamined += line?.bytesExamined ?? 0;
            let eventIdAtOffset = null;
            try {
                eventIdAtOffset = line ? parseIndexRecord(line.line).eventId : null;
            }
            catch {
                // A record-boundary parse failure is genuine index corruption and is
                // allowed to reach the one-shot self-healing rebuild. Non-boundary
                // offsets supplied by a forged cursor were rejected above.
                throw new Error("transcript index contains malformed JSON");
            }
            if (eventIdAtOffset !== cursor.beforeEventId) {
                if (indexedOffset !== undefined) {
                    throw new TranscriptPaginationError("BAD_CURSOR", "invalid transcript cursor");
                }
                const recoveredOffset = await locateIndexEvent(id, cursor.beforeEventId, metrics);
                if (recoveredOffset === null)
                    throw new TranscriptPaginationError("BAD_CURSOR", "transcript cursor is no longer available");
                end = recoveredOffset;
            }
        }
        finally {
            await indexHandle.close();
        }
    }
    const records = await collectIndexRecordsBackward(id, end, cursorOptions.limit + 1, metrics);
    const hasMore = records.length > cursorOptions.limit;
    if (hasMore)
        records.pop();
    records.reverse();
    const transcriptHandle = await open(transcriptPath(id), "r");
    const events = [];
    try {
        for (const { record } of records) {
            const bytes = Buffer.alloc(record.transcriptLength);
            const result = await transcriptHandle.read(bytes, 0, bytes.length, record.transcriptOffset);
            metrics.fileBytesExamined += result.bytesRead;
            metrics.rowsParsed += 1;
            if (result.bytesRead !== bytes.length)
                throw new Error("transcript changed after index validation");
            let raw;
            try {
                raw = JSON.parse(bytes.toString("utf8"));
            }
            catch {
                throw new Error("transcript row no longer matches its index");
            }
            const { [TRANSCRIPT_EVENT_ID_FIELD]: _persistedEventId, ...eventFields } = raw;
            const event = normalizeStoredAgentEvent(agent, eventFields);
            if (!event)
                throw new Error("transcript row no longer matches its index");
            events.push({ ...structuredClone(event), eventId: record.eventId });
        }
    }
    finally {
        await transcriptHandle.close();
    }
    const first = records[0];
    return {
        events,
        hasMore,
        nextCursor: hasMore && first
            ? encodeIndexedTranscriptCursor(id, first.record.eventId, first.indexOffset)
            : null,
    };
}
function markTranscriptIndexWarm(id) {
    const cold = !warmTranscriptIndexes.has(id);
    warmTranscriptIndexes.delete(id);
    warmTranscriptIndexes.set(id, true);
    while (warmTranscriptIndexes.size > TRANSCRIPT_INDEX_CACHE_LIMIT) {
        warmTranscriptIndexes.delete(warmTranscriptIndexes.keys().next().value);
    }
    return cold;
}
async function readTranscriptPageQueued(id, agent, cursorOptions) {
    const started = performance.now();
    const metrics = {
        sessionId: id,
        cold: markTranscriptIndexWarm(id),
        fileBytesExamined: 0,
        indexBytesExamined: 0,
        rowsParsed: 0,
        eventsReturned: 0,
        indexRebuilt: false,
        indexRecovered: false,
        elapsedMs: 0,
    };
    let page;
    try {
        try {
            await stat(transcriptPath(id));
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            page = { events: [], nextCursor: null, hasMore: false };
            return page;
        }
        let ensured = await ensureTranscriptIndex(id, agent);
        metrics.indexRebuilt = ensured.rebuilt;
        metrics.indexRecovered = ensured.recovered;
        if (ensured.rebuilt) {
            metrics.fileBytesExamined += ensured.meta.transcriptBytes;
            metrics.rowsParsed += ensured.meta.rows;
        }
        try {
            page = await readIndexedTranscriptPage(id, agent, ensured.meta, cursorOptions, metrics);
        }
        catch (error) {
            if (error instanceof TranscriptPaginationError || ensured.rebuilt)
                throw error;
            ensured = { meta: await rebuildTranscriptIndex(id, agent), rebuilt: true, recovered: true };
            metrics.indexRebuilt = true;
            metrics.indexRecovered = true;
            metrics.fileBytesExamined += ensured.meta.transcriptBytes;
            metrics.rowsParsed += ensured.meta.rows;
            page = await readIndexedTranscriptPage(id, agent, ensured.meta, cursorOptions, metrics);
        }
        return page;
    }
    finally {
        metrics.eventsReturned = page?.events.length ?? 0;
        metrics.elapsedMs = performance.now() - started;
        transcriptReadObserver?.({ ...metrics });
        console.info(`transcript read ${JSON.stringify(metrics)}`);
    }
}
export async function readTranscriptPage(id, agent, cursorOptions) {
    const previous = appendQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => { }).then(() => readTranscriptPageQueued(id, agent, cursorOptions));
    appendQueues.set(id, operation.then(() => undefined, () => undefined));
    return operation;
}
/** Wait until all events accepted so far are durable. Primarily used by
 * shutdown and tests; normal event delivery never waits on disk latency. */
export async function flushTranscript(id) {
    const queues = id
        ? [appendQueues.get(id)]
        : [...appendQueues.values()];
    await Promise.all(queues.filter((queue) => Boolean(queue)).map((queue) => queue.catch(() => { })));
    const errors = id
        ? (appendErrors.has(id) ? [appendErrors.get(id)] : [])
        : [...appendErrors.values()];
    if (errors.length > 0)
        throw errors[0];
}
export function forgetTranscript(id) {
    transcriptCache.delete(id);
    appendQueues.delete(id);
    appendErrors.delete(id);
    warmTranscriptIndexes.delete(id);
}
/** Remove a transcript even when an asynchronous append is already in flight.
 * The second unlink runs after the captured queue settles, preventing a late
 * append from resurrecting a session the user deleted. */
export function discardTranscript(id) {
    discardedTranscripts.add(id);
    const pending = appendQueues.get(id);
    transcriptCache.delete(id);
    appendQueues.delete(id);
    appendErrors.delete(id);
    try {
        rmSync(transcriptPath(id), { force: true });
        rmSync(transcriptIndexPath(id), { force: true });
        rmSync(transcriptIndexMetaPath(id), { force: true });
    }
    catch (error) {
        console.error(`failed to begin deleting transcript for session ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const cleanup = (pending ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => {
        try {
            rmSync(transcriptPath(id), { force: true });
            rmSync(transcriptIndexPath(id), { force: true });
            rmSync(transcriptIndexMetaPath(id), { force: true });
        }
        catch (error) {
            console.error(`failed to finish deleting transcript for session ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            discardedTranscripts.delete(id);
        }
    });
    void cleanup;
    return cleanup;
}
const PREVIEW_MAX = 280;
export function previewText(text) {
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > PREVIEW_MAX ? collapsed.slice(0, PREVIEW_MAX) : collapsed;
}
export function assistantEventText(event) {
    const parts = event.message?.content;
    if (!Array.isArray(parts))
        return null;
    const texts = parts
        .filter((part) => !!part &&
        part.type === "text" &&
        typeof part.text === "string")
        .map((part) => part.text)
        .filter((text) => text.trim());
    return texts.length > 0 ? texts.join(" ") : null;
}
export function previewFromTranscript(id, agent) {
    const file = transcriptPath(id);
    if (!existsSync(file))
        return null;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const event = normalizeStoredAgentEvent(agent, JSON.parse(lines[i]));
            if (event?.type === "assistant") {
                const text = assistantEventText(event);
                if (text)
                    return previewText(text);
            }
            else if (event?.type === "user_message" && typeof event.text === "string" && event.text.trim()) {
                return previewText(event.text);
            }
        }
        catch {
            // A corrupt historical line should not prevent backfilling later events.
        }
    }
    return null;
}
export function eventCountFromTranscript(id) {
    const file = transcriptPath(id);
    if (!existsSync(file))
        return 0;
    return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
}
