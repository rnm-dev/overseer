import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-bg-tasks-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-bg-tasks-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-bg-tasks-agent-"));
const fakeClaude = path.join(fakeDir, "claude.mjs");
// Mirrors `claude -p` 2.1.x: a query that leaves a background shell running
// reports its result, keeps the process alive, and when the task finishes
// starts a continuation query with its own init and result. total_cost_usd is
// cumulative over the process. FAKE_CONTINUE=0 exits without continuing.
writeFileSync(fakeClaude, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const out = (event) => console.log(JSON.stringify(event));
const usage = (n) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
// Peon writes the prompt to stdin, never argv.
const cont = !readFileSync(0, "utf8").includes("no-continue");
out({ type: "system", subtype: "init", session_id: "bg-test", model: "claude-test" });
out({ type: "assistant", message: { id: "m1", model: "claude-test", content: [{ type: "text", text: "Deploy started, waiting." }], usage: usage(10) } });
out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1" }] });
out({ type: "result", subtype: "success", is_error: false, result: "Deploy started, waiting.", num_turns: 2, total_cost_usd: 1, usage: usage(10) });
setTimeout(() => {
  out({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed" });
  out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  if (!cont) process.exit(0);
  out({ type: "system", subtype: "init", session_id: "bg-test", model: "claude-test" });
  out({ type: "assistant", message: { id: "m2", model: "claude-test", content: [{ type: "text", text: "Deploy finished." }], usage: usage(5) } });
  out({ type: "result", subtype: "success", is_error: false, result: "Deploy finished.", num_turns: 1, total_cost_usd: 1.5, usage: usage(5) });
  setTimeout(() => process.exit(0), 100);
}, 800);
`);
chmodSync(fakeClaude, 0o755);

const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");
settings.update({ agentCommand: fakeClaude, maxTurns: 1_000, taskTimeoutMs: 60_000 });

async function until(predicate: () => boolean, ms: number): Promise<void> {
  for (let waited = 0; waited < ms && !predicate(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a result with a live background task keeps the turn running until the continuation's result", async () => {
  const record = sessions.start({ id: "bg-continue", prompt: "deploy", dir: fakeDir, agent: "claude-code" });
  await until(() => record.lastMessagePreview?.includes("waiting") === true, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sessions.get(record.id)?.status, "running");

  await until(() => sessions.get(record.id)?.status === "completed", 5_000);
  const done = sessions.get(record.id)!;
  assert.equal(done.status, "completed");
  assert.equal(done.outcome, null);
  assert.match(done.lastMessagePreview ?? "", /finished/);
  assert.equal(done.turnCount, 3);
  assert.equal(done.usage.inputTokens, 15);
  assert.equal(done.usage.totalCostUsd, 1.5);
});

test("a process that exits without continuing still completes with the held answer", async () => {
  const record = sessions.start({ id: "bg-exit", prompt: "no-continue", dir: fakeDir, agent: "claude-code" });
  await until(() => sessions.get(record.id)?.status === "completed", 5_000);
  const done = sessions.get(record.id)!;
  assert.equal(done.outcome, null);
  assert.equal(done.turnCount, 2);
  assert.equal(done.usage.inputTokens, 10);
});
