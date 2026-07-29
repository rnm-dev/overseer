import { randomUUID } from "node:crypto";
import { assertPackageId } from "./paths.js";
const packageLocks = new Map();
export class ArmoryOperationError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ArmoryOperationError";
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
            throw new ArmoryOperationError("OPERATION_IN_PROGRESS", `Package ${id} already has a mutating operation in progress`);
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
