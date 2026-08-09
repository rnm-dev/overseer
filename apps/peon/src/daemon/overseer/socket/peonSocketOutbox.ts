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
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PEON_SOCKET_MAX_FRAME_BYTES, type
  PeonSocketDurableOptions,
  PeonSocketDurableResult,
  PeonSocketFrame,
  PeonSocketPriority,
} from "./peonSocketProtocol.js";
import { stateDir } from "../../runtime/xdgPaths.js";

export const DEFAULT_PEON_SOCKET_OUTBOX_MESSAGES = 5_000;
export const DEFAULT_PEON_SOCKET_OUTBOX_BYTES = 32 * 1024 * 1024;
export const PEON_SOCKET_DURABLE_DELIVERY_CAPABILITY = "durable-delivery-v1";
export const PEON_SOCKET_SELECTIVE_ACK_CAPABILITY = "durable-delivery-selective-ack-v1";

export interface PeonSocketOutboxMessage {
  epoch: string;
  cursor: string;
  messageId: string;
  priority: PeonSocketPriority;
  payload: PeonSocketFrame;
  payloadBytes: number;
  createdAt: number;
  capability?: string;
  dedupeKey?: string;
  coalesceKey?: string;
}

interface StoredMessage extends PeonSocketOutboxMessage {
  sequence: number;
}

interface OutboxState {
  version: 1;
  generation: number;
  epoch: string;
  destinationHash: string | null;
  negotiated: boolean;
  nextSequence: number;
  acknowledgedSequence: number;
  selectiveAckUsed?: boolean;
  selectivelyAcknowledged?: number[];
  messages: StoredMessage[];
}

interface StoredEnvelope {
  checksum: string;
  state: OutboxState;
}

type JournalMutation =
  | { generation: number; type: "enqueue"; message: StoredMessage }
  | { generation: number; type: "coalesce"; message: StoredMessage }
  | { generation: number; type: "ack"; sequence: number }
  | { generation: number; type: "selective_ack"; sequence: number }
  | { generation: number; type: "negotiated"; negotiated: boolean }
  | { generation: number; type: "destination"; destinationHash: string };

interface StoredJournalMutation {
  checksum: string;
  mutation: JournalMutation;
}

export interface PeonSocketOutboxStatus {
  epoch: string;
  earliestCursor: string | null;
  latestCursor: string | null;
  acknowledgedCursor: string | null;
  pendingMessages: number;
  pendingBytes: number;
  maxMessages: number;
  maxBytes: number;
  backpressured: boolean;
  negotiated: boolean;
  recoveredFromCorruption: boolean;
  lastError: string | null;
}

export interface PeonSocketOutboxOptions {
  fileBase?: string;
  maxMessages?: number;
  maxBytes?: number;
  now?: () => number;
  maxFrameBytes?: number;
  checkpointRecords?: number;
  checkpointBytes?: number;
}

function encodeCursor(sequence: number): string {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(sequence));
  return bytes.toString("base64url");
}

function decodeCursor(cursor: string): number | null {
  if (!/^[A-Za-z0-9_-]{11}$/.test(cursor)) return null;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length !== 8) return null;
    const value = bytes.readBigUInt64BE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const sequence = Number(value);
    return encodeCursor(sequence) === cursor ? sequence : null;
  } catch {
    return null;
  }
}

function checksum(state: OutboxState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function mutationChecksum(mutation: JournalMutation): string {
  return createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
}

function isFrame(value: unknown): value is PeonSocketFrame {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && typeof (value as PeonSocketFrame).type === "string";
}

function validState(value: unknown): value is OutboxState {
  const state = value as Partial<OutboxState> | null;
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.generation) || (state.generation ?? -1) < 0
    || typeof state.epoch !== "string" || state.epoch.length === 0
    || (state.destinationHash !== null && (typeof state.destinationHash !== "string" || !/^[a-f0-9]{64}$/.test(state.destinationHash)))
    || typeof state.negotiated !== "boolean"
    || (state.selectiveAckUsed !== undefined && typeof state.selectiveAckUsed !== "boolean")
    || !Number.isSafeInteger(state.nextSequence) || (state.nextSequence ?? 0) < 1
    || !Number.isSafeInteger(state.acknowledgedSequence) || (state.acknowledgedSequence ?? -1) < 0
    || !Array.isArray(state.messages)) return false;
  const nextSequence = state.nextSequence as number;
  const acknowledgedSequence = state.acknowledgedSequence as number;
  const selectivelyAcknowledged = state.selectivelyAcknowledged ?? [];
  if (!Array.isArray(selectivelyAcknowledged)
    || selectivelyAcknowledged.some((sequence, index) => !Number.isSafeInteger(sequence)
      || sequence <= acknowledgedSequence || sequence >= nextSequence
      || (index > 0 && sequence <= selectivelyAcknowledged[index - 1]!))) return false;
  const retired = new Set(selectivelyAcknowledged);
  let previous = acknowledgedSequence;
  for (const message of state.messages) {
    if (!message || !Number.isSafeInteger(message.sequence) || message.sequence <= previous
      || message.sequence >= nextSequence || message.epoch !== state.epoch
      || message.cursor !== encodeCursor(message.sequence) || typeof message.messageId !== "string"
      || !["critical", "control", "normal", "bulk"].includes(message.priority)
      || !isFrame(message.payload) || !Number.isSafeInteger(message.payloadBytes) || message.payloadBytes < 0
      || typeof message.createdAt !== "number" || !Number.isFinite(message.createdAt)
      || (message.capability !== undefined && (typeof message.capability !== "string" || message.capability.length === 0))
      || (message.dedupeKey !== undefined && typeof message.dedupeKey !== "string")
      || (message.coalesceKey !== undefined && typeof message.coalesceKey !== "string")) return false;
    previous = message.sequence;
  }
  if (state.messages.some((message) => retired.has(message.sequence))) return false;
  const present = new Set(state.messages.map((message) => message.sequence));
  for (let sequence = acknowledgedSequence + 1; sequence < nextSequence; sequence += 1) {
    if (!present.has(sequence) && !retired.has(sequence)) return false;
  }
  return acknowledgedSequence < nextSequence;
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

export class PeonSocketOutbox {
  private readonly fileBase: string;
  private readonly slots: [string, string];
  private readonly journalPath: string;
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly maxFrameBytes: number;
  private readonly checkpointRecords: number;
  private readonly checkpointBytes: number;
  private journalRecords = 0;
  private journalBytes = 0;
  private currentMessageBytes = 0;
  private current: OutboxState;
  private recoveredFromCorruption = false;
  private lastError: string | null = null;
  private rejectedForCapacity = false;

  constructor(options: PeonSocketOutboxOptions = {}) {
    this.fileBase = options.fileBase ?? path.join(stateDir(), "overseer-socket-outbox");
    this.slots = [`${this.fileBase}.a.json`, `${this.fileBase}.b.json`];
    this.journalPath = `${this.fileBase}.journal`;
    this.maxMessages = options.maxMessages ?? DEFAULT_PEON_SOCKET_OUTBOX_MESSAGES;
    this.maxBytes = options.maxBytes ?? DEFAULT_PEON_SOCKET_OUTBOX_BYTES;
    this.now = options.now ?? Date.now;
    this.maxFrameBytes = options.maxFrameBytes ?? PEON_SOCKET_MAX_FRAME_BYTES;
    this.checkpointRecords = options.checkpointRecords ?? 256;
    this.checkpointBytes = options.checkpointBytes ?? 1024 * 1024;
    this.current = this.load();
    this.currentMessageBytes = this.messagesBytes(this.current.messages);
  }

  status(): PeonSocketOutboxStatus {
    const pendingBytes = this.pendingBytes();
    return {
      epoch: this.current.epoch,
      earliestCursor: this.current.messages[0]?.cursor ?? null,
      latestCursor: this.current.messages.at(-1)?.cursor ?? null,
      acknowledgedCursor: this.current.acknowledgedSequence > 0 ? encodeCursor(this.current.acknowledgedSequence) : null,
      pendingMessages: this.current.messages.length,
      pendingBytes,
      maxMessages: this.maxMessages,
      maxBytes: this.maxBytes,
      backpressured: this.rejectedForCapacity || this.current.messages.length >= this.maxMessages || pendingBytes >= this.maxBytes,
      negotiated: this.current.negotiated,
      recoveredFromCorruption: this.recoveredFromCorruption,
      lastError: this.lastError,
    };
  }

  pending(): PeonSocketOutboxMessage[] {
    return this.current.messages.map(({ sequence: _sequence, ...message }) => structuredClone(message));
  }

  pendingForDelivery(): PeonSocketOutboxMessage[] {
    // Payloads are normalized on admission and never mutated in place. The
    // socket supervisor only reads this view, so avoid deep-cloning the entire
    // durable backlog on startup, coalescing checks, ACKs, and retries.
    return this.current.messages.map(({ sequence: _sequence, ...message }) => message);
  }

  hasUsedSelectiveAcks(): boolean {
    // Older checkpoints written during the additive rollout may have durable
    // holes without the explicit marker. A non-empty hole set is equivalent
    // evidence and must fence a legacy handshake resume after upgrade.
    return this.current.selectiveAckUsed === true
      || (this.current.selectivelyAcknowledged?.length ?? 0) > 0;
  }

  bindDestination(destinationHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(destinationHash)) return false;
    if (this.current.destinationHash === destinationHash) return true;
    if (this.current.destinationHash === null) {
      const next = { ...this.current };
      next.generation += 1;
      next.destinationHash = destinationHash;
      return this.commit(next, { generation: next.generation, type: "destination", destinationHash }, this.currentMessageBytes);
    }

    try {
      const hadPending = this.current.messages.length > 0;
      const suffix = `.destination-${this.now()}`;
      for (const slot of this.slots) {
        if (!existsSync(slot)) continue;
        if (hadPending) renameSync(slot, `${slot}${suffix}`);
        else rmSync(slot, { force: true });
      }
      if (existsSync(this.journalPath)) {
        if (hadPending) renameSync(this.journalPath, `${this.journalPath}${suffix}`);
        else rmSync(this.journalPath, { force: true });
      }
      const initial: OutboxState = {
        version: 1,
        generation: 0,
        epoch: randomUUID(),
        destinationHash,
        negotiated: false,
        nextSequence: 1,
        acknowledgedSequence: 0,
        selectiveAckUsed: false,
        selectivelyAcknowledged: [],
        messages: [],
      };
      this.writeSlot(initial);
      this.writeSlot(initial, this.slots[1]);
      this.current = initial;
      this.currentMessageBytes = 0;
      this.rejectedForCapacity = false;
      this.lastError = hadPending
        ? "socket destination changed; pending messages were quarantined instead of forwarded to another Overseer"
        : null;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  setNegotiated(negotiated: boolean): boolean {
    if (this.current.negotiated === negotiated) return true;
    const next = { ...this.current };
    next.generation += 1;
    next.negotiated = negotiated;
    return this.commit(next, { generation: next.generation, type: "negotiated", negotiated }, this.currentMessageBytes);
  }

  enqueue(payload: PeonSocketFrame, options: PeonSocketDurableOptions = {}): PeonSocketDurableResult {
    if (!isFrame(payload)) return { accepted: false, code: "INVALID_MESSAGE", error: "durable socket messages require a frame type" };
    let payloadBytes: number;
    let normalizedPayload: PeonSocketFrame;
    try {
      const serialized = JSON.stringify(payload);
      payloadBytes = Buffer.byteLength(serialized);
      normalizedPayload = JSON.parse(serialized) as PeonSocketFrame;
    }
    catch { return { accepted: false, code: "INVALID_MESSAGE", error: "durable socket message is not serializable" }; }

    if (options.dedupeKey) {
      const duplicate = this.current.messages.find((message) => message.dedupeKey === options.dedupeKey);
      if (duplicate) return this.accepted(duplicate);
    }

    const coalescedIndex = options.coalesceKey
      ? this.current.messages.findIndex((message) => message.coalesceKey === options.coalesceKey)
      : -1;
    if (coalescedIndex >= 0) {
      const existing = this.current.messages[coalescedIndex];
      const replacement: StoredMessage = {
        ...existing,
        payload: normalizedPayload,
        payloadBytes,
        priority: options.priority ?? existing.priority,
        capability: options.capability ?? existing.capability,
        dedupeKey: options.dedupeKey ?? existing.dedupeKey,
      };
      const next = { ...this.current, messages: [...this.current.messages] };
      next.messages[coalescedIndex] = replacement;
      if (!this.fitsWireFrame(replacement)) return this.frameSizeError();
      const nextBytes = this.currentMessageBytes - this.messageBytes(existing) + this.messageBytes(replacement);
      if (nextBytes > this.maxBytes) return this.capacityError();
      next.generation += 1;
      if (!this.commit(next, { generation: next.generation, type: "coalesce", message: replacement }, nextBytes)) return this.persistError();
      return this.accepted(replacement);
    }

    if (this.current.messages.length >= this.maxMessages) return this.capacityError();
    const sequence = this.current.nextSequence;
    const message: StoredMessage = {
      epoch: this.current.epoch,
      sequence,
      cursor: encodeCursor(sequence),
      messageId: randomUUID(),
      priority: options.priority ?? "normal",
      payload: normalizedPayload,
      payloadBytes,
      createdAt: this.now(),
      ...(options.capability ? { capability: options.capability } : {}),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
    };
    const next = { ...this.current, messages: [...this.current.messages] };
    next.generation += 1;
    next.nextSequence += 1;
    next.messages.push(message);
    if (!this.fitsWireFrame(message)) return this.frameSizeError();
    const messageBytes = this.messageBytes(message);
    const nextBytes = this.currentMessageBytes === 0 ? messageBytes + 2 : this.currentMessageBytes + messageBytes + 1;
    if (nextBytes > this.maxBytes) return this.capacityError();
    if (!this.commit(next, { generation: next.generation, type: "enqueue", message }, nextBytes)) return this.persistError();
    return this.accepted(message);
  }

  acknowledge(epoch: string, cursor: string): boolean {
    if (epoch !== this.current.epoch) return false;
    const sequence = decodeCursor(cursor);
    if (sequence === null || sequence >= this.current.nextSequence) return false;
    if (sequence <= this.current.acknowledgedSequence) return true;
    const next = { ...this.current, messages: this.current.messages.filter((message) => message.sequence > sequence) };
    next.generation += 1;
    next.acknowledgedSequence = sequence;
    next.selectivelyAcknowledged = (this.current.selectivelyAcknowledged ?? []).filter((retired) => retired > sequence);
    const nextBytes = this.messagesBytes(next.messages);
    if (!this.commit(next, { generation: next.generation, type: "ack", sequence }, nextBytes)) return false;
    this.rejectedForCapacity = false;
    return true;
  }

  acknowledgeSelective(epoch: string, cursor: string): boolean {
    if (epoch !== this.current.epoch) return false;
    const sequence = decodeCursor(cursor);
    if (sequence === null || sequence >= this.current.nextSequence) return false;
    if (sequence <= this.current.acknowledgedSequence
      || (this.current.selectivelyAcknowledged ?? []).includes(sequence)) return true;
    if (!this.current.messages.some((message) => message.sequence === sequence)) return false;
    const retired = [...(this.current.selectivelyAcknowledged ?? []), sequence].sort((left, right) => left - right);
    let acknowledgedSequence = this.current.acknowledgedSequence;
    const retiredSet = new Set(retired);
    while (retiredSet.delete(acknowledgedSequence + 1)) acknowledgedSequence += 1;
    // A permanently blocked prefix must not let selective retirement create an
    // unbounded on-disk hole set while newly admitted messages keep replacing
    // the retired ones. Prefix compaction may consume the new retirement, so
    // enforce the bound only on the residual holes that must be persisted.
    if (retiredSet.size > this.maxMessages) return false;
    const next = {
      ...this.current,
      generation: this.current.generation + 1,
      acknowledgedSequence,
      selectiveAckUsed: true,
      selectivelyAcknowledged: [...retiredSet].sort((left, right) => left - right),
      messages: this.current.messages.filter((message) => message.sequence !== sequence),
    };
    const nextBytes = this.messagesBytes(next.messages);
    if (!this.commit(next, { generation: next.generation, type: "selective_ack", sequence }, nextBytes)) return false;
    this.rejectedForCapacity = false;
    return true;
  }

  isAcknowledged(epoch: string, cursor: string): boolean {
    if (epoch !== this.current.epoch) return false;
    const sequence = decodeCursor(cursor);
    return sequence !== null && (sequence <= this.current.acknowledgedSequence
      || (this.current.selectivelyAcknowledged ?? []).includes(sequence));
  }

  private accepted(message: StoredMessage): PeonSocketDurableResult {
    return { accepted: true, epoch: message.epoch, cursor: message.cursor, messageId: message.messageId };
  }

  private capacityError(): PeonSocketDurableResult {
    this.rejectedForCapacity = true;
    this.lastError = "durable socket outbox limit reached";
    return { accepted: false, code: "OUTBOX_FULL", error: this.lastError };
  }

  private frameSizeError(): PeonSocketDurableResult {
    return { accepted: false, code: "INVALID_MESSAGE", error: "durable socket message exceeds the wire frame limit" };
  }

  private fitsWireFrame(message: StoredMessage): boolean {
    return Buffer.byteLength(JSON.stringify({
      type: "durable_message",
      epoch: message.epoch,
      cursor: message.cursor,
      messageId: message.messageId,
      priority: message.priority,
      ...(message.capability ? { capability: message.capability } : {}),
      payload: message.payload,
    })) <= this.maxFrameBytes;
  }

  private persistError(): PeonSocketDurableResult {
    return { accepted: false, code: "PERSIST_FAILED", error: this.lastError ?? "unable to persist durable socket message" };
  }

  private pendingBytes(): number {
    return this.currentMessageBytes;
  }

  private messageBytes(message: StoredMessage): number {
    return Buffer.byteLength(JSON.stringify(message));
  }

  private messagesBytes(messages: StoredMessage[]): number {
    return messages.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(messages));
  }

  private commit(next: OutboxState, mutation?: JournalMutation, nextMessageBytes?: number): boolean {
    try {
      if (mutation) this.appendMutation(mutation);
      else this.writeSlot(next);
      this.current = next;
      this.currentMessageBytes = nextMessageBytes ?? this.messagesBytes(next.messages);
      this.lastError = null;
      this.maybeCheckpoint();
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private appendMutation(mutation: JournalMutation): void {
    const directory = path.dirname(this.fileBase);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const envelope: StoredJournalMutation = { checksum: mutationChecksum(mutation), mutation };
    const line = `${JSON.stringify(envelope)}\n`;
    const descriptor = openSync(this.journalPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, line);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.journalRecords += 1;
    this.journalBytes += Buffer.byteLength(line);
  }

  private maybeCheckpoint(): void {
    if (this.journalRecords < this.checkpointRecords && this.journalBytes < this.checkpointBytes) return;
    try {
      this.writeSlot(this.current);
      this.replaceJournal();
      this.journalRecords = 0;
      this.journalBytes = 0;
    } catch (error) {
      // The fsynced journal remains authoritative when optional compaction
      // fails, so an already accepted mutation must not be reported as lost.
      this.lastError = `durable socket outbox checkpoint failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private replaceJournal(): void {
    const directory = path.dirname(this.fileBase);
    const temporary = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, "", { mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporary, constants.O_RDONLY);
      try { fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      renameSync(temporary, this.journalPath);
      syncDirectory(directory);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private applyMutation(state: OutboxState, mutation: JournalMutation): OutboxState | null {
    if (mutation.generation !== state.generation + 1) return null;
    const next: OutboxState = { ...state, messages: [...state.messages] };
    next.generation = mutation.generation;
    if (mutation.type === "enqueue") {
      if (mutation.message.sequence !== next.nextSequence) return null;
      next.messages.push(mutation.message);
      next.nextSequence += 1;
    } else if (mutation.type === "coalesce") {
      const index = next.messages.findIndex((message) => message.sequence === mutation.message.sequence);
      if (index < 0) return null;
      next.messages[index] = mutation.message;
    } else if (mutation.type === "ack") {
      if (!Number.isSafeInteger(mutation.sequence) || mutation.sequence <= next.acknowledgedSequence
        || mutation.sequence >= next.nextSequence) return null;
      next.acknowledgedSequence = mutation.sequence;
      next.messages = next.messages.filter((message) => message.sequence > mutation.sequence);
      next.selectivelyAcknowledged = (next.selectivelyAcknowledged ?? []).filter((sequence) => sequence > mutation.sequence);
    } else if (mutation.type === "selective_ack") {
      if (!Number.isSafeInteger(mutation.sequence) || mutation.sequence <= next.acknowledgedSequence
        || mutation.sequence >= next.nextSequence
        || !next.messages.some((message) => message.sequence === mutation.sequence)) return null;
      const retired = new Set([...(next.selectivelyAcknowledged ?? []), mutation.sequence]);
      while (retired.delete(next.acknowledgedSequence + 1)) next.acknowledgedSequence += 1;
      next.selectiveAckUsed = true;
      next.selectivelyAcknowledged = [...retired].sort((left, right) => left - right);
      next.messages = next.messages.filter((message) => message.sequence !== mutation.sequence);
    } else if (mutation.type === "negotiated") {
      if (typeof mutation.negotiated !== "boolean") return null;
      next.negotiated = mutation.negotiated;
    } else {
      if (next.destinationHash !== null || !/^[a-f0-9]{64}$/.test(mutation.destinationHash)) return null;
      next.destinationHash = mutation.destinationHash;
    }
    return validState(next) ? next : null;
  }

  private replayJournal(base: OutboxState): OutboxState {
    if (!existsSync(this.journalPath)) return base;
    const raw = readFileSync(this.journalPath, "utf8");
    if (!raw) return base;
    let state = base;
    let invalid = false;
    const parts = raw.split("\n");
    const hasPartialTail = parts.at(-1) !== "";
    if (hasPartialTail) parts.pop();
    const lines = parts.filter(Boolean);
    for (const line of lines) {
      if (invalid) break;
      try {
        const envelope = JSON.parse(line) as Partial<StoredJournalMutation>;
        const mutation = envelope.mutation as JournalMutation | undefined;
        if (!mutation || envelope.checksum !== mutationChecksum(mutation)) throw new Error("invalid journal checksum");
        if (mutation.generation <= state.generation) continue;
        const next = this.applyMutation(state, mutation);
        if (!next) throw new Error("invalid journal mutation");
        state = next;
        this.journalRecords += 1;
        this.journalBytes += Buffer.byteLength(`${line}\n`);
      } catch {
        invalid = true;
      }
    }
    invalid ||= hasPartialTail;
    if (invalid) {
      this.recoveredFromCorruption = true;
      this.lastError = "recovered durable socket outbox from a valid journal prefix";
      try {
        this.writeSlot(state);
        renameSync(this.journalPath, `${this.journalPath}.corrupt-${this.now()}`);
        this.journalRecords = 0;
        this.journalBytes = 0;
      } catch { /* Keep the last valid in-memory state and original evidence when recovery cannot be checkpointed. */ }
    }
    return state;
  }

  private load(): OutboxState {
    const candidates: OutboxState[] = [];
    let invalid = 0;
    for (const slot of this.slots) {
      if (!existsSync(slot)) continue;
      try {
        const envelope = JSON.parse(readFileSync(slot, "utf8")) as Partial<StoredEnvelope>;
        if (!validState(envelope.state) || envelope.checksum !== checksum(envelope.state)) throw new Error("invalid outbox slot");
        candidates.push(envelope.state);
      } catch {
        invalid += 1;
      }
    }
    const selected = candidates.sort((a, b) => b.generation - a.generation)[0];
    if (selected) {
      if (invalid) {
        this.recoveredFromCorruption = true;
        this.lastError = "recovered durable socket outbox from the last valid slot";
      }
      return this.replayJournal(selected);
    }

    if (invalid) {
      this.recoveredFromCorruption = true;
      this.lastError = "durable socket outbox was corrupt; quarantined invalid slots and started a new epoch";
      const suffix = `.corrupt-${this.now()}`;
      for (const slot of this.slots) {
        if (!existsSync(slot)) continue;
        try { renameSync(slot, `${slot}${suffix}`); }
        catch { /* Preserve the original for operator inspection when quarantine fails. */ }
      }
      if (existsSync(this.journalPath)) {
        try { renameSync(this.journalPath, `${this.journalPath}${suffix}`); }
        catch { /* Preserve it for operator inspection when quarantine fails. */ }
      }
    }
    const initial: OutboxState = {
      version: 1,
      generation: 0,
      epoch: randomUUID(),
      destinationHash: null,
      negotiated: false,
      nextSequence: 1,
      acknowledgedSequence: 0,
      selectiveAckUsed: false,
      selectivelyAcknowledged: [],
      messages: [],
    };
    this.writeSlot(initial);
    this.writeSlot(initial, this.slots[1]);
    return this.replayJournal(initial);
  }

  private writeSlot(state: OutboxState, targetOverride?: string): void {
    const directory = path.dirname(this.fileBase);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = targetOverride ?? this.slots[state.generation % 2];
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const envelope: StoredEnvelope = { checksum: checksum(state), state };
    try {
      writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
      const descriptor = openSync(temporary, constants.O_RDONLY);
      try { fsyncSync(descriptor); }
      finally { closeSync(descriptor); }
      renameSync(temporary, target);
      syncDirectory(directory);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
