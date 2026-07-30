import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import path from "node:path";
import { stateDir } from "../../xdgPaths.js";
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
function checksum(state) {
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
function validRecord(value) {
    const record = value;
    return Boolean(record)
        && typeof record.commandId === "string"
        && typeof record.requestHash === "string"
        && typeof record.operation === "string"
        && typeof record.peonId === "string"
        && typeof record.actorUserId === "string"
        && typeof record.authority === "string"
        && record.authority.length > 0
        && Number.isSafeInteger(record.admittedGeneration)
        && (record.admittedGeneration ?? -1) >= 0
        && (record.command === undefined || (Boolean(record.command) && typeof record.command === "object" && !Array.isArray(record.command)))
        && ["accepted", "running", "terminal"].includes(record.state)
        && typeof record.acceptedAt === "number"
        && typeof record.updatedAt === "number";
}
function validState(value) {
    const state = value;
    return Boolean(state)
        && state.version === 1
        && Number.isSafeInteger(state.generation)
        && Array.isArray(state.records)
        && state.records.every(validRecord)
        && new Set(state.records.map((record) => record.commandId)).size === state.records.length
        && Array.isArray(state.tombstones)
        && state.tombstones.every((item) => item && typeof item.commandId === "string"
            && typeof item.requestHash === "string" && typeof item.expiredAt === "number");
}
function syncDirectory(directory) {
    const descriptor = openSync(directory, constants.O_RDONLY);
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
export class ReverseCommandLedger {
    fileBase;
    slots;
    now;
    maxRecords;
    maxBytes;
    retentionMs;
    tombstoneRetentionMs;
    current;
    lastError = null;
    recoveredFromCorruption = false;
    recoveryBlocked = false;
    constructor(options = {}) {
        this.fileBase = options.fileBase ?? path.join(stateDir(), "overseer-reverse-command-ledger");
        this.slots = [`${this.fileBase}.a.json`, `${this.fileBase}.b.json`];
        this.now = options.now ?? Date.now;
        this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
        this.tombstoneRetentionMs = options.tombstoneRetentionMs ?? DEFAULT_RETENTION_MS;
        this.current = this.load();
    }
    status() {
        return {
            records: this.current.records.length,
            bytes: Buffer.byteLength(JSON.stringify(this.current)),
            recoveredFromCorruption: this.recoveredFromCorruption,
            recoveryBlocked: this.recoveryBlocked,
            lastError: this.lastError,
        };
    }
    get(commandId) {
        const record = this.current.records.find((candidate) => candidate.commandId === commandId);
        return record ? structuredClone(record) : undefined;
    }
    records() {
        return this.current.records.map((record) => structuredClone(record));
    }
    admit(input) {
        if (this.recoveryBlocked) {
            return { kind: "persist_failed", error: this.lastError ?? "reverse command ledger recovery is blocked" };
        }
        const duplicate = this.current.records.find((record) => record.commandId === input.commandId);
        if (duplicate) {
            return duplicate.requestHash === input.requestHash && duplicate.authority === input.authority
                ? { kind: "replayed", record: structuredClone(duplicate) }
                : { kind: "reused", record: structuredClone(duplicate) };
        }
        const tombstone = this.current.tombstones.find((item) => item.commandId === input.commandId);
        if (tombstone)
            return tombstone.requestHash === input.requestHash ? { kind: "expired" } : { kind: "reused" };
        const acceptedAt = this.now();
        const record = { ...input, state: "accepted", acceptedAt, updatedAt: acceptedAt };
        const next = this.compacted();
        next.records.push(record);
        next.generation += 1;
        if (next.records.length > this.maxRecords || Buffer.byteLength(JSON.stringify(next)) > this.maxBytes) {
            return { kind: "full" };
        }
        if (!this.persist(next))
            return { kind: "persist_failed", error: this.lastError ?? "unable to persist command admission" };
        return { kind: "accepted", record: structuredClone(record) };
    }
    rebindAcceptedGeneration(commandId, authority, generation) {
        return this.transition(commandId, "accepted", (record) => {
            if (record.authority !== authority)
                return null;
            return { ...record, admittedGeneration: generation, updatedAt: this.now() };
        });
    }
    markRunning(commandId, authority, generation) {
        return this.transition(commandId, "accepted", (record) => (record.authority === authority && record.admittedGeneration === generation
            ? { ...record, state: "running", updatedAt: this.now() }
            : null));
    }
    markTerminal(commandId, authority, generation, result) {
        const completedAt = this.now();
        return this.transition(commandId, "running", (record) => (record.authority === authority && record.admittedGeneration === generation
            ? {
                ...record,
                state: "terminal",
                result: structuredClone(result),
                completedAt,
                updatedAt: completedAt,
            }
            : null));
    }
    bindResultCursor(commandId, authority, cursor) {
        return this.transition(commandId, "terminal", (record) => (record.authority === authority
            ? { ...record, resultCursor: cursor, updatedAt: this.now() }
            : null));
    }
    acknowledgeCursor(cursor) {
        const matches = this.current.records.filter((record) => record.resultCursor === cursor && !record.resultAcknowledgedAt);
        if (matches.length === 0)
            return true;
        const acknowledgedAt = this.now();
        const ids = new Set(matches.map((record) => record.commandId));
        const next = structuredClone(this.current);
        next.generation += 1;
        next.records = next.records.map((record) => ids.has(record.commandId)
            ? { ...record, resultAcknowledgedAt: acknowledgedAt, updatedAt: acknowledgedAt }
            : record);
        return this.persist(next);
    }
    recoverInterrupted(resultFactory) {
        const interrupted = this.current.records.filter((record) => record.state === "running");
        for (const record of interrupted) {
            this.markTerminal(record.commandId, record.authority, record.admittedGeneration, resultFactory(record));
        }
        return interrupted.map((record) => this.get(record.commandId)).filter(Boolean);
    }
    compact() {
        const next = this.compacted();
        if (JSON.stringify(next) === JSON.stringify(this.current))
            return true;
        next.generation = this.current.generation + 1;
        return this.persist(next);
    }
    compacted() {
        const now = this.now();
        const next = structuredClone(this.current);
        const retained = [];
        for (const record of next.records) {
            const eligible = record.state === "terminal"
                && record.resultAcknowledgedAt !== undefined
                && record.completedAt !== undefined
                && now - record.completedAt >= this.retentionMs;
            if (eligible)
                next.tombstones.push({ commandId: record.commandId, requestHash: record.requestHash, expiredAt: now });
            else
                retained.push(record);
        }
        next.records = retained;
        next.tombstones = next.tombstones.filter((item) => now - item.expiredAt < this.tombstoneRetentionMs);
        return next;
    }
    transition(commandId, expected, mutate) {
        if (this.recoveryBlocked)
            return false;
        const index = this.current.records.findIndex((record) => record.commandId === commandId);
        if (index < 0)
            return false;
        const current = this.current.records[index];
        if (current.state !== expected)
            return false;
        const replacement = mutate(current);
        if (!replacement)
            return false;
        const next = structuredClone(this.current);
        next.generation += 1;
        next.records[index] = replacement;
        return this.persist(next);
    }
    persist(next) {
        const directory = path.dirname(this.fileBase);
        const target = this.slots[next.generation % 2];
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            writeFileSync(temporary, JSON.stringify({ checksum: checksum(next), state: next }), {
                mode: 0o600,
                flag: "wx",
            });
            const descriptor = openSync(temporary, constants.O_RDONLY);
            try {
                fsyncSync(descriptor);
            }
            finally {
                closeSync(descriptor);
            }
            renameSync(temporary, target);
            syncDirectory(directory);
            this.current = next;
            this.lastError = null;
            return true;
        }
        catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
            return false;
        }
    }
    load() {
        const candidates = [];
        let sawFile = false;
        for (const slot of this.slots) {
            if (!existsSync(slot))
                continue;
            sawFile = true;
            try {
                const envelope = JSON.parse(readFileSync(slot, "utf8"));
                if (!validState(envelope.state) || envelope.checksum !== checksum(envelope.state))
                    throw new Error("invalid checksum");
                candidates.push(envelope.state);
            }
            catch {
                this.recoveredFromCorruption = true;
            }
        }
        const generations = candidates.map((candidate) => candidate.generation).sort((a, b) => b - a);
        const missingRequiredPeer = candidates.length === 1 && generations[0] >= 2;
        const generationGap = generations.length === 2 && generations[0] - generations[1] !== 1;
        if (this.recoveredFromCorruption || missingRequiredPeer || generationGap) {
            this.recoveryBlocked = true;
            this.lastError = "reverse command ledger recovery blocked: corrupt, missing, or gapped durable generation";
            return candidates.sort((a, b) => b.generation - a.generation)[0]
                ?? { version: 1, generation: 0, records: [], tombstones: [] };
        }
        if (candidates.length > 0)
            return candidates.sort((a, b) => b.generation - a.generation)[0];
        if (sawFile) {
            this.recoveryBlocked = true;
            this.lastError = "reverse command ledger recovery blocked: no valid durable generation";
        }
        return { version: 1, generation: 0, records: [], tombstones: [] };
    }
}
