import { EventEmitter } from "node:events";
export const WARNING_COOLDOWN_MS = 5 * 60 * 1000;
const recordsStore = new Map();
const activeRunsStore = new Map();
const resumePending = new Set();
const steerPending = new Set();
const queueDispatchPending = new Set();
const warningThrottleStore = new Map();
const emitter = new EventEmitter();
export const sessionState = {
    records: {
        get: (id) => recordsStore.get(id),
        set: (record) => {
            recordsStore.set(record.id, record);
        },
        delete: (id) => recordsStore.delete(id),
        has: (id) => recordsStore.has(id),
        values: () => recordsStore.values(),
        entries: () => recordsStore.entries(),
        size: () => recordsStore.size,
    },
    activeRuns: {
        get: (id) => activeRunsStore.get(id),
        set: (id, run) => {
            activeRunsStore.set(id, run);
        },
        delete: (id) => activeRunsStore.delete(id),
        has: (id) => activeRunsStore.has(id),
        entries: () => activeRunsStore.entries(),
        size: () => activeRunsStore.size,
    },
    resumePending: {
        has: (id) => resumePending.has(id),
        add: (id) => {
            resumePending.add(id);
        },
        delete: (id) => {
            resumePending.delete(id);
        },
        size: () => resumePending.size,
        values: () => resumePending.values(),
    },
    steerPending: {
        has: (id) => steerPending.has(id),
        add: (id) => {
            steerPending.add(id);
        },
        delete: (id) => {
            steerPending.delete(id);
        },
        size: () => steerPending.size,
        values: () => steerPending.values(),
    },
    queueDispatchPending: {
        has: (id) => queueDispatchPending.has(id),
        add: (id) => {
            queueDispatchPending.add(id);
        },
        delete: (id) => {
            queueDispatchPending.delete(id);
        },
        size: () => queueDispatchPending.size,
        values: () => queueDispatchPending.values(),
    },
    warningThrottle: {
        get: (key) => warningThrottleStore.get(key),
        set: (key, value) => {
            warningThrottleStore.set(key, value);
        },
    },
    emitter: {
        emit: emitter.emit.bind(emitter),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
    },
};
