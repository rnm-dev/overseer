import { EventEmitter } from "node:events";
import type { AgentRun } from "../agents/index.js";
import type { SessionRecord } from "./sessionTypes.js";

export const WARNING_COOLDOWN_MS = 5 * 60 * 1000;

interface SessionRecordBucket {
  get(id: string): SessionRecord | undefined;
  set(record: SessionRecord): void;
  delete(id: string): boolean;
  has(id: string): boolean;
  values(): IterableIterator<SessionRecord>;
  entries(): IterableIterator<[string, SessionRecord]>;
  size(): number;
}

interface ActiveRunBucket {
  get(id: string): AgentRun | undefined;
  set(id: string, run: AgentRun): void;
  delete(id: string): boolean;
  has(id: string): boolean;
  entries(): IterableIterator<[string, AgentRun]>;
  size(): number;
}

interface PendingRunBucket {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): void;
  size(): number;
}

interface WarningBucket {
  get(key: string): { at: number; ratio: number } | undefined;
  set(key: string, value: { at: number; ratio: number }): void;
}

const recordsStore = new Map<string, SessionRecord>();
const activeRunsStore = new Map<string, AgentRun>();
const resumePending: Set<string> = new Set();
const steerPending: Set<string> = new Set();
const queueDispatchPending: Set<string> = new Set();
const warningThrottleStore = new Map<string, { at: number; ratio: number }>();
const emitter = new EventEmitter();

export const sessionState = {
  records: {
    get: (id: string): SessionRecord | undefined => recordsStore.get(id),
    set: (record: SessionRecord): void => {
      recordsStore.set(record.id, record);
    },
    delete: (id: string): boolean => recordsStore.delete(id),
    has: (id: string): boolean => recordsStore.has(id),
    values: (): IterableIterator<SessionRecord> => recordsStore.values(),
    entries: (): IterableIterator<[string, SessionRecord]> => recordsStore.entries(),
    size: (): number => recordsStore.size,
  } as const satisfies SessionRecordBucket,
  activeRuns: {
    get: (id: string): AgentRun | undefined => activeRunsStore.get(id),
    set: (id: string, run: AgentRun): void => {
      activeRunsStore.set(id, run);
    },
    delete: (id: string): boolean => activeRunsStore.delete(id),
    has: (id: string): boolean => activeRunsStore.has(id),
    entries: (): IterableIterator<[string, AgentRun]> => activeRunsStore.entries(),
    size: (): number => activeRunsStore.size,
  } as const satisfies ActiveRunBucket,
  resumePending: {
    has: (id: string): boolean => resumePending.has(id),
    add: (id: string): void => {
      resumePending.add(id);
    },
    delete: (id: string): void => {
      resumePending.delete(id);
    },
    size: (): number => resumePending.size,
  } as const satisfies PendingRunBucket,
  steerPending: {
    has: (id: string): boolean => steerPending.has(id),
    add: (id: string): void => {
      steerPending.add(id);
    },
    delete: (id: string): void => {
      steerPending.delete(id);
    },
    size: (): number => steerPending.size,
  } as const satisfies PendingRunBucket,
  queueDispatchPending: {
    has: (id: string): boolean => queueDispatchPending.has(id),
    add: (id: string): void => {
      queueDispatchPending.add(id);
    },
    delete: (id: string): void => {
      queueDispatchPending.delete(id);
    },
    size: (): number => queueDispatchPending.size,
  } as const satisfies PendingRunBucket,
  warningThrottle: {
    get: (key: string): { at: number; ratio: number } | undefined => warningThrottleStore.get(key),
    set: (key: string, value: { at: number; ratio: number }): void => {
      warningThrottleStore.set(key, value);
    },
  } as const satisfies WarningBucket,
  emitter: {
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  } as const,
} as const;
