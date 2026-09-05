import { availableParallelism } from "node:os";

export const MAX_AUTO_TEST_CONCURRENCY = 8;

export function defaultTestConcurrency(parallelism = availableParallelism()) {
  const usableParallelism = Number.isInteger(parallelism) && parallelism > 0 ? parallelism : 1;
  return Math.max(1, Math.min(MAX_AUTO_TEST_CONCURRENCY, usableParallelism - 2));
}

export function resolveTestConcurrency(value, parallelism = availableParallelism()) {
  if (value === undefined || value === "") return defaultTestConcurrency(parallelism);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("PEON_TEST_CONCURRENCY must be a positive integer");
  }
  const requested = Number(value);
  if (!Number.isSafeInteger(requested)) {
    throw new Error("PEON_TEST_CONCURRENCY must be a safe positive integer");
  }
  return requested;
}
