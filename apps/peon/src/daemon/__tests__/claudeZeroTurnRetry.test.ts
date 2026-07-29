import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-claude-zero-turn-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-claude-zero-turn-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-fake-claude-zero-turn-"));
const fakeClaude = path.join(fakeDir, "claude.mjs");
const retryCountPath = path.join(fakeDir, "retry-count");

writeFileSync(fakeClaude, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "";
const retryCountPath = ${JSON.stringify(retryCountPath)};
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-claude-session", model: "claude-test" }));
if (prompt === "retry me") {
  const count = existsSync(retryCountPath) ? Number(readFileSync(retryCountPath, "utf8")) : 0;
  writeFileSync(retryCountPath, String(count + 1));
  if (count === 0) {
    console.log(JSON.stringify({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] }
    }));
    console.log(JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "No response requested.",
      num_turns: 0, duration_ms: 0, total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, model: "<synthetic>"
    }));
    process.exit(0);
  }
}
console.log(JSON.stringify({
  type: "assistant",
  message: { model: "claude-test", content: [{ type: "text", text: "handled " + prompt }] }
}));
console.log(JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "handled " + prompt,
  num_turns: 1, duration_ms: 10, total_cost_usd: 0.01,
  usage: { input_tokens: 3, output_tokens: 2 }, model: "claude-test"
}));
`);
chmodSync(fakeClaude, 0o755);

const { readTranscript } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");

settings.update({ agentCommand: fakeClaude, taskTimeoutMs: 2_000 });

async function waitUntil(id: string, predicate: (record: NonNullable<ReturnType<typeof sessions.get>>) => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const record = sessions.get(id);
    if (record && predicate(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not reach the expected state`);
}

test("Claude resumed zero-turn synthetic result retries the prompt exactly once", async () => {
  const record = sessions.start({
    id: "claude-zero-turn-retry-session",
    prompt: "first",
    dir: fakeDir,
    agent: "claude-code",
  });
  await waitUntil(record.id, (current) => current.status === "completed");

  sessions.resume(record.id, "retry me");
  await waitUntil(record.id, (current) => current.status === "completed" && current.turnCount === 2);

  const current = sessions.get(record.id)!;
  const transcript = readTranscript(record.id, "claude-code");
  assert.equal(readFileSync(retryCountPath, "utf8"), "2");
  assert.deepEqual(current.followUpPrompts, ["retry me"]);
  assert.equal(
    transcript.filter((event) => event.type === "user_message" && event.text === "retry me").length,
    1,
  );
  assert.equal(current.lastMessagePreview, "handled retry me");
  assert.equal(current.usage?.inputTokens, 6);
  assert.equal(current.usage?.outputTokens, 4);
});
