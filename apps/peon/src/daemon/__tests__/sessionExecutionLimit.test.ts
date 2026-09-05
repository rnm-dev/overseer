import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-execution-limit-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-execution-limit-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-execution-limit-agent-"));
const fakeClaude = path.join(fakeDir, "claude.mjs");
writeFileSync(fakeClaude, `#!/usr/bin/env node
process.on("SIGINT", () => {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "interrupted", num_turns: 2 }));
  process.exit(0);
});
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "limit-test", model: "claude-test" }));
for (const text of ["first", "second"]) console.log(JSON.stringify({
  type: "assistant", message: { id: text, model: "claude-test", usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 1 }, content: [{ type: "text", text }] }
}));
setTimeout(() => process.exit(0), 5000);
`);
chmodSync(fakeClaude, 0o755);

const { readTranscript } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");
settings.update({ agentCommand: fakeClaude, maxTurns: 1, taskTimeoutMs: 2_000 });

test("turn-limit completion exposes a durable machine-readable reason and warning", async () => {
  const record = sessions.start({ id: "turn-limit-session", prompt: "keep going", dir: fakeDir, agent: "claude-code" });
  for (let attempt = 0; attempt < 300 && sessions.get(record.id)?.status !== "completed"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const completed = sessions.get(record.id)!;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.terminalReason, {
    code: "turn_limit_exceeded",
    message: "Exceeded max turns (1) without concluding",
    canResume: true,
    maxTurns: 1,
    turnBudget: 1,
    turnsUsed: 2,
  });
  assert.equal(completed.outcome?.result, "failure");
  assert.equal(completed.usage?.inputTokens, 20);
  assert.equal(completed.usage?.cacheReadInputTokens, 40);
  assert.equal(completed.usage?.outputTokens, null);
  assert.equal(completed.usage?.quality, "partial");
  const usageEvents = readTranscript(record.id, "claude-code").filter((event) => event.subtype === "usage");
  assert.equal(usageEvents.length, 2);
  assert.ok(usageEvents.every((event) => event.usage_session_id === record.id && typeof event.usage_run_id === "string"));
  assert.ok(readTranscript(record.id, "claude-code").some((event) =>
    event.type === "warning"
    && event.code === "turn_limit_exceeded"
    && event.action === "continue"
    && event.canResume === true));
});

test("task timeout uses the same structured terminal contract", async () => {
  const silentClaude = path.join(fakeDir, "silent-claude.mjs");
  writeFileSync(silentClaude, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 5000);\n");
  chmodSync(silentClaude, 0o755);
  settings.update({ agentCommand: silentClaude, maxTurns: 1_000, taskTimeoutMs: 50 });

  const record = sessions.start({ id: "timeout-session", prompt: "keep going", dir: fakeDir, agent: "claude-code" });
  for (let attempt = 0; attempt < 300 && sessions.get(record.id)?.status !== "completed"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const reason = sessions.get(record.id)?.terminalReason;
  assert.equal(reason?.code, "task_timeout");
  assert.equal(reason?.canResume, true);
  if (reason?.code === "task_timeout") {
    assert.equal(reason.timeoutMs, 50);
    assert.ok(reason.elapsedMs >= 40);
  }
  assert.ok(readTranscript(record.id, "claude-code").some((event) =>
    event.type === "warning" && event.code === "task_timeout" && event.action === "continue"));
});
