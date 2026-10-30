import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-queue-drain-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-queue-drain-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-queue-drain-agent-"));
const log = path.join(fakeDir, "lifecycle.log");
writeFileSync(log, "");
const fakeClaude = path.join(fakeDir, "claude.mjs");
// Reports its result, then keeps its process alive the way Claude does while
// it flushes and shuts its MCP servers down.
writeFileSync(fakeClaude, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "start " + Date.now() + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "drain-test", model: "claude-test" }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1 }));
setTimeout(() => { appendFileSync(${JSON.stringify(log)}, "exit " + Date.now() + "\\n"); process.exit(0); }, 1500);
`);
chmodSync(fakeClaude, 0o755);

const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");
settings.update({ agentCommand: fakeClaude, maxTurns: 1_000, taskTimeoutMs: 60_000 });

async function until(predicate: () => boolean, ms: number): Promise<void> {
  for (let waited = 0; waited < ms && !predicate(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a queued turn waits for the finished process to exit before resuming", async () => {
  const record = sessions.start({ id: "drain-session", prompt: "first", dir: fakeDir, agent: "claude-code" });
  sessions.enqueue(record.id, "second");
  const starts = () => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("start")).length;
  await until(() => starts() >= 2, 8_000);

  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" "));
  assert.deepEqual(lines.slice(0, 3).map(([kind]) => kind), ["start", "exit", "start"]);
  assert.ok(Number(lines[2][1]) >= Number(lines[1][1]));
});

test("a direct follow-up sent while the process drains is queued, not raced", async () => {
  // Let the previous test's second process finish writing to the log.
  await until(() => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("exit")).length >= 2, 5_000);
  writeFileSync(log, "");
  const record = sessions.start({ id: "drain-direct", prompt: "first", dir: fakeDir, agent: "claude-code" });
  await until(() => sessions.get(record.id)?.status === "completed", 5_000);
  sessions.resume(record.id, "second");
  const starts = () => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("start")).length;
  await until(() => starts() >= 2, 8_000);

  const kinds = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
  assert.deepEqual(kinds.slice(0, 3), ["start", "exit", "start"]);
});
