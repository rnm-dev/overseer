import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveTestConcurrency } from "./test-concurrency.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "src", "daemon", "__tests__");
const tests = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testDir, name))
  .concat(path.join(root, "scripts", "test-concurrency.test.mjs"));
const serialTests = [
  path.join(testDir, "armoryConfiguration.test.ts"),
  path.join(testDir, "previewRevisionPublisher.test.ts"),
];
const regularTests = tests.filter((test) => !serialTests.includes(test));
const testConcurrency = resolveTestConcurrency(process.env.PEON_TEST_CONCURRENCY);

// npm appends `npm test -- <args>` after the script. Put those Node test-runner
// flags before the positional files so filters such as --test-name-pattern
// actually take effect instead of silently running the entire suite.
const run = (selectedTests, concurrency) => spawnSync(process.execPath, [
  "--import", "tsx",
  "--import", path.join(root, "scripts", "test-isolation.mjs"),
  "--test",
  `--test-concurrency=${concurrency}`,
  "--test-timeout=60000",
  ...process.argv.slice(2),
  ...selectedTests,
], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "test", PEON_TEST_RUN: "1" },
  stdio: "inherit",
});

const regularResult = run(regularTests, testConcurrency);
if (regularResult.error) throw regularResult.error;
if (regularResult.status !== 0) process.exit(regularResult.status ?? 1);

// Filesystem watch timing, subprocess deadlines and latency assertions must be
// independent from unrelated workers so they measure Peon behavior, not suite
// contention. Keep this list narrow instead of serializing the release suite.
const serialResult = run(serialTests, 1);
if (serialResult.error) throw serialResult.error;
process.exit(serialResult.status ?? 1);
