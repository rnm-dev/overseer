import { randomUUID } from "node:crypto";
import type { ArmoryOperation } from "./contracts.js";
import { assertPackageId } from "./paths.js";
import type { ArmoryOperationStore } from "./stores.js";

const packageLocks = new Map<string, string>();

export async function withArmoryPackageLock<T>(directory: string, packageId: string, ownerId: string, runner: () => Promise<T>): Promise<T> {
  const id = assertPackageId(packageId);
  const lockKey = `${directory}\0${id}`;
  const blockingOperation = packageLocks.get(lockKey);
  if (blockingOperation) {
    throw operationInProgressError(id, blockingOperation, null);
  }
  packageLocks.set(lockKey, ownerId);
  try { return await runner(); }
  finally { if (packageLocks.get(lockKey) === ownerId) packageLocks.delete(lockKey); }
}

export type ArmoryMutatingOperationKind = ArmoryOperation["kind"];

interface ArmoryOperationErrorOptions extends ErrorOptions {
  details?: Record<string, unknown>;
}

export class ArmoryOperationError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(readonly code: string, message: string, options?: ArmoryOperationErrorOptions) {
    super(message, options);
    this.name = "ArmoryOperationError";
    this.details = options?.details;
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
      throw operationInProgressError(id, blockingOperation, await this.store.get(blockingOperation), this.now());
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

function operationInProgressError(packageId: string, operationId: string, operation: ArmoryOperation | null, now = Date.now()): ArmoryOperationError {
  const phase = operation?.phase ?? "unknown";
  const kind = operation?.kind ?? "mutating";
  const status = operation?.status ?? "running";
  const ageMs = operation?.startedAt === null || operation?.startedAt === undefined ? null : Math.max(0, now - operation.startedAt);
  const progress = operation?.progress === null || operation?.progress === undefined ? "unknown progress" : `${operation.progress}%`;
  const age = ageMs === null ? "unknown age" : `${Math.ceil(ageMs / 1000)}s old`;
  const currentMessage = operation?.message ? ` Current step: ${operation.message}.` : "";
  const recovery = "Wait for the blocking operation to finish. If it no longer advances, finish or cancel sessions using this package and restart the Peon to recover it, then retry.";
  return new ArmoryOperationError(
    "OPERATION_IN_PROGRESS",
    `Package ${packageId} is blocked by ${kind} operation ${operationId} (${status}, phase ${phase}, ${progress}, ${age}).${currentMessage} ${recovery}`,
    {
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
    },
  );
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
