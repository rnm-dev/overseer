import { randomUUID } from "node:crypto";
import { assertPackageId } from "./paths.js";
const packageLocks = new Map();
export async function withArmoryPackageLock(directory, packageId, ownerId, runner) {
    const id = assertPackageId(packageId);
    const lockKey = `${directory}\0${id}`;
    const blockingOperation = packageLocks.get(lockKey);
    if (blockingOperation) {
        throw operationInProgressError(id, blockingOperation, null);
    }
    packageLocks.set(lockKey, ownerId);
    try {
        return await runner();
    }
    finally {
        if (packageLocks.get(lockKey) === ownerId)
            packageLocks.delete(lockKey);
    }
}
export class ArmoryOperationError extends Error {
    code;
    details;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ArmoryOperationError";
        this.details = options?.details;
    }
}
export class ArmoryOperationCoordinator {
    store;
    now;
    running = new Map();
    constructor(store, now = () => Date.now()) {
        this.store = store;
        this.now = now;
    }
    async start(packageId, kind, runner) {
        const id = assertPackageId(packageId);
        const lockKey = `${this.store.directory}\0${id}`;
        const blockingOperation = packageLocks.get(lockKey);
        if (blockingOperation) {
            throw operationInProgressError(id, blockingOperation, await this.store.get(blockingOperation), this.now());
        }
        const operation = {
            id: randomUUID(), packageId: id, kind, status: "queued", phase: "queued", progress: 0,
            message: "Operation queued", errorCode: null, startedAt: null, finishedAt: null,
        };
        packageLocks.set(lockKey, operation.id);
        try {
            await this.store.save(operation);
        }
        catch (error) {
            packageLocks.delete(lockKey);
            throw error;
        }
        const promise = this.run(operation, lockKey, runner);
        this.running.set(operation.id, promise);
        void promise.finally(() => this.running.delete(operation.id)).catch(() => undefined);
        return operation;
    }
    async wait(operationId) {
        const active = this.running.get(operationId);
        if (active)
            return active;
        const operation = await this.store.get(operationId);
        if (!operation)
            throw new ArmoryOperationError("OPERATION_NOT_FOUND", `Armory operation not found: ${operationId}`);
        return operation;
    }
    async run(operation, lockKey, runner) {
        let current = {
            ...operation, status: "running", phase: "starting", progress: 0,
            message: "Operation started", startedAt: this.now(),
        };
        try {
            await this.store.save(current);
            const update = async (phase, progress, message) => {
                current = { ...current, phase, progress, message: boundedMessage(message) };
                await this.store.save(current);
            };
            await runner({ operationId: operation.id, packageId: operation.packageId, update });
            current = {
                ...current, status: "success", phase: "complete", progress: 100,
                message: "Operation completed", errorCode: null, finishedAt: this.now(),
            };
        }
        catch (error) {
            current = {
                ...current, status: "failure", phase: "failed", progress: null,
                message: boundedMessage(safeErrorMessage(error)), errorCode: stableErrorCode(error), finishedAt: this.now(),
            };
        }
        finally {
            packageLocks.delete(lockKey);
        }
        await this.store.save(current);
        return current;
    }
}
function operationInProgressError(packageId, operationId, operation, now = Date.now()) {
    const phase = operation?.phase ?? "unknown";
    const kind = operation?.kind ?? "mutating";
    const status = operation?.status ?? "running";
    const ageMs = operation?.startedAt === null || operation?.startedAt === undefined ? null : Math.max(0, now - operation.startedAt);
    const progress = operation?.progress === null || operation?.progress === undefined ? "unknown progress" : `${operation.progress}%`;
    const age = ageMs === null ? "unknown age" : `${Math.ceil(ageMs / 1000)}s old`;
    const currentMessage = operation?.message ? ` Current step: ${operation.message}.` : "";
    const recovery = "Wait for the blocking operation to finish. If it no longer advances, finish or cancel sessions using this package and restart the Peon to recover it, then retry.";
    return new ArmoryOperationError("OPERATION_IN_PROGRESS", `Package ${packageId} is blocked by ${kind} operation ${operationId} (${status}, phase ${phase}, ${progress}, ${age}).${currentMessage} ${recovery}`, {
        details: {
            blockingOperationId: operationId,
            packageId,
            kind,
            status,
            phase,
            progress: operation?.progress ?? null,
            operationMessage: operation?.message ?? null,
            startedAt: operation?.startedAt ?? null,
            ageMs,
            recovery,
        },
    });
}
function stableErrorCode(error) {
    if (error instanceof ArmoryOperationError && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code))
        return error.code;
    return "OPERATION_FAILED";
}
function safeErrorMessage(error) {
    if (error instanceof ArmoryOperationError)
        return error.message;
    return "Armory operation failed";
}
function boundedMessage(message) {
    return message.slice(0, 1000);
}
