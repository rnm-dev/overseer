import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "src", "daemon", "__tests__");
const tests = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join(testDir, name));

// npm appends `npm test -- <args>` after the script. Put those Node test-runner
// flags before the positional files so filters such as --test-name-pattern
// actually take effect instead of silently running the entire suite.
const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--import",
  path.join(root, "scripts", "test-isolation.mjs"),
  "--test",
  ...process.argv.slice(2),
  ...tests,
], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "test", PEON_TEST_RUN: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
