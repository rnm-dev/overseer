#!/usr/bin/env node
import { runDeterministicSoak } from "../src/index.js";

function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? Number(fallback) : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    process.stderr.write(`${name} must be a positive integer\n`);
    process.exit(2);
  }
  return value;
}

const durationMs = integerArgument("--duration-ms", process.env.CONFORMANCE_SOAK_DURATION_MS ?? 60_000);
const ticksPerMs = integerArgument("--ticks-per-ms", 1);
const durationTicks = durationMs * ticksPerMs;
if (!Number.isSafeInteger(durationTicks)) {
  process.stderr.write("duration tick product must be a safe integer\n");
  process.exit(2);
}
const result = runDeterministicSoak({ durationTicks });
process.stdout.write(`${JSON.stringify({
  ...result,
  mode: "deterministic-local",
  configuredDurationMs: durationMs,
  productionEvidence: false,
})}\n`);
if (!result.passed) process.exitCode = 1;
