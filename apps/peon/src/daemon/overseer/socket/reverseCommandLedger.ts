import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { stateDir } from "../../xdgPaths.js";
import type { PeonSocketFrame } from "./peonSocketProtocol.js";

export type ReverseCommandState = "accepted" | "running" | "terminal";

export interface ReverseCommandRecord {
  commandId: string;
  requestHash: string;
  operation: string;
  peonId: string;
  sessionId?: string;
  actorUserId: string;
  authority: string;
  admittedGeneration: number;
  command?: PeonSocketFrame;
  state: ReverseCommandState;
  acceptedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: PeonSocketFrame;
  resultCursor?: string;
  resultAcknowledgedAt?: number;
}

interface ReverseCommandTombstone {
  commandId: string;
  requestHash: string;
  expiredAt: number;
}

interface LedgerState {
  version: 1;
  generation: number;
  records: ReverseCommandRecord[];
  tombstones: ReverseCommandTombstone[];
}

interface StoredLedger {
  checksum: string;
  state: LedgerState;
}

export interface ReverseCommandLedgerOptions {
  fileBase?: string;
  now?: () => number;
  maxRecords?: number;
  maxBytes?: number;
  retentionMs?: number;
  tombstoneRetentionMs?: number;
}

export type ReverseCommandAdmission =
  | { kind: "accepted"; record: ReverseCommandRecord }
  | { kind: "replayed"; record: ReverseCommandRecord }
  | { kind: "reused"; record?: ReverseCommandRecord }
  | { kind: "expired" }
  | { kind: "full" }
  | { kind: "persist_failed"; error: string };

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RECORDS = 10_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function checksum(state: LedgerState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function validRecord(value: unknown): value is ReverseCommandRecord {
  const record = value as Partial<ReverseCommandRecord> | null;
  return Boolean(record)
    && typeof record!.commandId === "string"
    && typeof record!.requestHash === "string"
    && typeof record!.operation === "string"
    && typeof record!.peonId === "string"
    && typeof record!.actorUserId === "string"
    && typeof record!.authority === "string"
    && record!.authority.length > 0
    && Number.isSafeInteger(record!.admittedGeneration)
    && (record!.admittedGeneration ?? -1) >= 0
    && (record!.command === undefined || (Boolean(record!.command) && typeof record!.command === "object" && !Array.isArray(record!.command)))
    && ["accepted", "running", "terminal"].includes(record!.state as string)
    && typeof record!.acceptedAt === "number"
    && typeof record!.updatedAt === "number";
}

function validState(value: unknown): value is LedgerState {
  const state = value as Partial<LedgerState> | null;
  return Boolean(state)
    && state!.version === 1
    && Number.isSafeInteger(state!.generation)
    && Array.isArray(state!.records)
    && state!.records.every(validRecord)
    && new Set(state!.records.map((record) => record.commandId)).size === state!.records.length
    && Array.isArray(state!.tombstones)
    && state!.tombstones.every((item) => item && typeof item.commandId === "string"
      && typeof item.requestHash === "string" && typeof item.expiredAt === "number");
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

export class ReverseCommandLedger {
  private readonly fileBase: string;
  private readonly slots: [string, string];
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly tombstoneRetentionMs: number;
  private current: LedgerState;
  private lastError: string | null = null;
  private recoveredFromCorruption = false;
  private recoveryBlocked = false;

  constructor(options: ReverseCommandLedgerOptions = {}) {
    this.fileBase = options.fileBase ?? path.join(stateDir(), "overseer-reverse-command-ledger");
    this.slots = [`${this.fileBase}.a.json`, `${this.fileBase}.b.json`];
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.tombstoneRetentionMs = options.tombstoneRetentionMs ?? DEFAULT_RETENTION_MS;
    this.current = this.load();
  }

  status(): { records: number; bytes: number; recoveredFromCorruption: boolean; recoveryBlocked: boolean; lastError: string | null } {
    return {
      records: this.current.records.length,
      bytes: Buffer.byteLength(JSON.stringify(this.current)),
      recoveredFromCorruption: this.recoveredFromCorruption,
      recoveryBlocked: this.recoveryBlocked,
      lastError: this.lastError,
    };
  }

  get(commandId: string): ReverseCommandRecord | undefined {
    const record = this.current.records.find((candidate) => candidate.commandId === commandId);
    return record ? structuredClone(record) : undefined;
  }

  records(): ReverseCommandRecord[] {
    return this.current.records.map((record) => structuredClone(record));
  }

  admit(input: Omit<ReverseCommandRecord, "state" | "acceptedAt" | "updatedAt">): ReverseCommandAdmission {
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
    if (tombstone) return tombstone.requestHash === input.requestHash ? { kind: "expired" } : { kind: "reused" };

    const acceptedAt = this.now();
    const record: ReverseCommandRecord = { ...input, state: "accepted", acceptedAt, updatedAt: acceptedAt };
    const next = this.compacted();
    next.records.push(record);
    next.generation += 1;
    if (next.records.length > this.maxRecords || Buffer.byteLength(JSON.stringify(next)) > this.maxBytes) {
      return { kind: "full" };
    }
    if (!this.persist(next)) return { kind: "persist_failed", error: this.lastError ?? "unable to persist command admission" };
    return { kind: "accepted", record: structuredClone(record) };
  }

  rebindAcceptedGeneration(commandId: string, authority: string, generation: number): boolean {
    return this.transition(commandId, "accepted", (record) => {
      if (record.authority !== authority) return null;
      return { ...record, admittedGeneration: generation, updatedAt: this.now() };
    });
  }

  markRunning(commandId: string, authority: string, generation: number): boolean {
    return this.transition(commandId, "accepted", (record) => (
      record.authority === authority && record.admittedGeneration === generation
        ? { ...record, state: "running", updatedAt: this.now() }
        : null
    ));
  }

  markTerminal(commandId: string, authority: string, generation: number, result: PeonSocketFrame): boolean {
    const completedAt = this.now();
    return this.transition(commandId, "running", (record) => (
      record.authority === authority && record.admittedGeneration === generation
        ? {
            ...record,
            state: "terminal",
            result: structuredClone(result),
            completedAt,
            updatedAt: completedAt,
          }
        : null
    ));
  }

  bindResultCursor(commandId: string, authority: string, cursor: string): boolean {
    return this.transition(commandId, "terminal", (record) => (
      record.authority === authority
        ? { ...record, resultCursor: cursor, updatedAt: this.now() }
        : null
    ));
  }

  acknowledgeCursor(cursor: string): boolean {
    const matches = this.current.records.filter((record) => record.resultCursor === cursor && !record.resultAcknowledgedAt);
    if (matches.length === 0) return true;
    const acknowledgedAt = this.now();
    const ids = new Set(matches.map((record) => record.commandId));
    const next = structuredClone(this.current);
    next.generation += 1;
    next.records = next.records.map((record) => ids.has(record.commandId)
      ? { ...record, resultAcknowledgedAt: acknowledgedAt, updatedAt: acknowledgedAt }
      : record);
    return this.persist(next);
  }

  recoverInterrupted(resultFactory: (record: ReverseCommandRecord) => PeonSocketFrame | null): ReverseCommandRecord[] {
    const interrupted = this.current.records.filter((record) => record.state === "running");
    for (const record of interrupted) {
      const result = resultFactory(record);
      if (result) this.markTerminal(record.commandId, record.authority, record.admittedGeneration, result);
    }
    return interrupted.map((record) => this.get(record.commandId)!).filter(Boolean);
  }

  compact(): boolean {
    const next = this.compacted();
    if (JSON.stringify(next) === JSON.stringify(this.current)) return true;
    next.generation = this.current.generation + 1;
    return this.persist(next);
  }

  private compacted(): LedgerState {
    const now = this.now();
    const next = structuredClone(this.current);
    const retained: ReverseCommandRecord[] = [];
    for (const record of next.records) {
      const eligible = record.state === "terminal"
        && record.resultAcknowledgedAt !== undefined
        && record.completedAt !== undefined
        && now - record.completedAt >= this.retentionMs;
      if (eligible) next.tombstones.push({ commandId: record.commandId, requestHash: record.requestHash, expiredAt: now });
      else retained.push(record);
    }
    next.records = retained;
    next.tombstones = next.tombstones.filter((item) => now - item.expiredAt < this.tombstoneRetentionMs);
    return next;
  }

  private transition(
    commandId: string,
    expected: ReverseCommandState,
    mutate: (record: ReverseCommandRecord) => ReverseCommandRecord | null,
  ): boolean {
    if (this.recoveryBlocked) return false;
    const index = this.current.records.findIndex((record) => record.commandId === commandId);
    if (index < 0) return false;
    const current = this.current.records[index]!;
    if (current.state !== expected) return false;
    const replacement = mutate(current);
    if (!replacement) return false;
    const next = structuredClone(this.current);
    next.generation += 1;
    next.records[index] = replacement;
    return this.persist(next);
  }

  private persist(next: LedgerState): boolean {
    const directory = path.dirname(this.fileBase);
    const target = this.slots[next.generation % 2];
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ checksum: checksum(next), state: next } satisfies StoredLedger), {
        mode: 0o600,
        flag: "wx",
      });
      const descriptor = openSync(temporary, constants.O_RDONLY);
      try { fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      renameSync(temporary, target);
      syncDirectory(directory);
      this.current = next;
      this.lastError = null;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private load(): LedgerState {
    const candidates: LedgerState[] = [];
    let sawFile = false;
    for (const slot of this.slots) {
      if (!existsSync(slot)) continue;
      sawFile = true;
      try {
        const envelope = JSON.parse(readFileSync(slot, "utf8")) as Partial<StoredLedger>;
        if (!validState(envelope.state) || envelope.checksum !== checksum(envelope.state)) throw new Error("invalid checksum");
        candidates.push(envelope.state);
      } catch {
        this.recoveredFromCorruption = true;
      }
    }
    const generations = candidates.map((candidate) => candidate.generation).sort((a, b) => b - a);
    const missingRequiredPeer = candidates.length === 1 && generations[0]! >= 2;
    const generationGap = generations.length === 2 && generations[0]! - generations[1]! !== 1;
    if (this.recoveredFromCorruption || missingRequiredPeer || generationGap) {
      this.recoveryBlocked = true;
      this.lastError = "reverse command ledger recovery blocked: corrupt, missing, or gapped durable generation";
      return candidates.sort((a, b) => b.generation - a.generation)[0]
        ?? { version: 1, generation: 0, records: [], tombstones: [] };
    }
    if (candidates.length > 0) return candidates.sort((a, b) => b.generation - a.generation)[0]!;
    if (sawFile) {
      this.recoveryBlocked = true;
      this.lastError = "reverse command ledger recovery blocked: no valid durable generation";
    }
    return { version: 1, generation: 0, records: [], tombstones: [] };
  }
}
