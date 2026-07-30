#!/usr/bin/env node
import { runDeterministicSoak } from "../src/index.js";

const ALLOWED_ARGUMENTS = new Set(["--duration-ms", "--ticks-per-ms"]);

for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!ALLOWED_ARGUMENTS.has(name)) {
    process.stderr.write(`unknown argument: ${name}\n`);
    process.exit(2);
  }
  if (process.argv[index + 1] === undefined || process.argv[index + 1].startsWith("--")) {
    process.stderr.write(`${name} requires a value\n`);
    process.exit(2);
  }
  if (process.argv.indexOf(name) !== index) {
    process.stderr.write(`${name} may be specified only once\n`);
    process.exit(2);
  }
}

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
