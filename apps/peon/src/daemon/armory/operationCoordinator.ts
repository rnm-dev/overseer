import { randomUUID } from "node:crypto";
import type { ArmoryOperation } from "./contracts.js";
import { assertPackageId } from "./paths.js";
import type { ArmoryOperationStore } from "./stores.js";

const packageLocks = new Map<string, string>();

export type ArmoryMutatingOperationKind = ArmoryOperation["kind"];

export class ArmoryOperationError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArmoryOperationError";
  }
}

export interface ArmoryOperationContext {
  readonly operationId: string;
  readonly packageId: string;
  update(phase: string, progress: number | null, message: string): Promise<void>;
}

export class ArmoryOperationCoordinator {
  private readonly running = new Map<string, Promise<ArmoryOperation>>();

  constructor(private readonly store: ArmoryOperationStore, private readonly now = () => Date.now()) {}

  async start(
    packageId: string,
    kind: ArmoryMutatingOperationKind,
    runner: (context: ArmoryOperationContext) => Promise<void>,
  ): Promise<ArmoryOperation> {
    const id = assertPackageId(packageId);
    const lockKey = `${this.store.directory}\0${id}`;
    const blockingOperation = packageLocks.get(lockKey);
    if (blockingOperation) {
      throw new ArmoryOperationError("OPERATION_IN_PROGRESS", `Package ${id} already has a mutating operation in progress`);
    }

    const operation: ArmoryOperation = {
      id: randomUUID(), packageId: id, kind, status: "queued", phase: "queued", progress: 0,
      message: "Operation queued", errorCode: null, startedAt: null, finishedAt: null,
    };
    packageLocks.set(lockKey, operation.id);
    try {
      await this.store.save(operation);
    } catch (error) {
      packageLocks.delete(lockKey);
      throw error;
    }
    const promise = this.run(operation, lockKey, runner);
    this.running.set(operation.id, promise);
    void promise.finally(() => this.running.delete(operation.id)).catch(() => undefined);
    return operation;
  }

  async wait(operationId: string): Promise<ArmoryOperation> {
    const active = this.running.get(operationId);
    if (active) return active;
    const operation = await this.store.get(operationId);
    if (!operation) throw new ArmoryOperationError("OPERATION_NOT_FOUND", `Armory operation not found: ${operationId}`);
    return operation;
  }

  private async run(
    operation: ArmoryOperation,
    lockKey: string,
    runner: (context: ArmoryOperationContext) => Promise<void>,
  ): Promise<ArmoryOperation> {
    let current: ArmoryOperation = {
      ...operation, status: "running", phase: "starting", progress: 0,
      message: "Operation started", startedAt: this.now(),
    };
    try {
      await this.store.save(current);
      const update = async (phase: string, progress: number | null, message: string): Promise<void> => {
        current = { ...current, phase, progress, message: boundedMessage(message) };
        await this.store.save(current);
      };
      await runner({ operationId: operation.id, packageId: operation.packageId, update });
      current = {
        ...current, status: "success", phase: "complete", progress: 100,
        message: "Operation completed", errorCode: null, finishedAt: this.now(),
      };
    } catch (error) {
      current = {
        ...current, status: "failure", phase: "failed", progress: null,
        message: boundedMessage(safeErrorMessage(error)), errorCode: stableErrorCode(error), finishedAt: this.now(),
      };
    } finally {
      packageLocks.delete(lockKey);
    }
    await this.store.save(current);
    return current;
  }
}

function stableErrorCode(error: unknown): string {
  if (error instanceof ArmoryOperationError && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)) return error.code;
  return "OPERATION_FAILED";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ArmoryOperationError) return error.message;
  return "Armory operation failed";
}

function boundedMessage(message: string): string {
  return message.slice(0, 1000);
}
