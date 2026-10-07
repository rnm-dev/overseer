import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-transient-retry-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-transient-retry-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-fake-claude-transient-"));
const fakeClaude = path.join(fakeDir, "claude.mjs");
const attemptsDir = fakeDir;

// The prompt selects the failure the fake provider reproduces. "flaky" fails
// once with a provider 500 and then succeeds; "unauthorized" always fails with
// something only a human can fix.
writeFileSync(fakeClaude, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const promptIndex = process.argv.indexOf("-p");
const prompt = promptIndex >= 0 ? process.argv[promptIndex + 1] : "";
const counter = path.join(${JSON.stringify(attemptsDir)}, "attempts-" + prompt.replace(/[^a-z]/gi, ""));
const attempt = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(attempt));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-transient-session", model: "claude-test" }));
const fail = (message) => {
  console.log(JSON.stringify({
    type: "result", subtype: "error_during_execution", is_error: true, errors: [message],
    num_turns: 0, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 0 }, model: "claude-test"
  }));
  process.exit(0);
};
if (prompt === "unauthorized") fail("API Error: 401 invalid api key");
if (prompt === "flaky" && attempt === 1) fail("API Error: 500 Internal Server Error");
console.log(JSON.stringify({
  type: "assistant",
  message: { model: "claude-test", content: [{ type: "text", text: "handled " + prompt }] }
}));
console.log(JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "handled " + prompt,
  num_turns: 1, duration_ms: 10, usage: { input_tokens: 3, output_tokens: 2 }, model: "claude-test"
}));
`);
chmodSync(fakeClaude, 0o755);

const { readTranscript } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");

settings.update({ agentCommand: fakeClaude, taskTimeoutMs: 5_000 });

function attempts(prompt: string): number {
  const counter = path.join(attemptsDir, `attempts-${prompt.replace(/[^a-z]/gi, "")}`);
  return existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
}

async function waitUntil(id: string, predicate: (record: NonNullable<ReturnType<typeof sessions.get>>) => boolean): Promise<void> {
  for (let i = 0; i < 1_500; i++) {
    const record = sessions.get(id);
    if (record && predicate(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not reach the expected state`);
}

test("a transient provider failure replays the turn and the failure stays visible", async () => {
  const record = sessions.start({
    id: "transient-retry-session",
    prompt: "flaky",
    dir: fakeDir,
    agent: "claude-code",
  });
  await waitUntil(record.id, (current) => current.status === "completed" && current.turnCount > 0);

  const current = sessions.get(record.id)!;
  assert.equal(attempts("flaky"), 2);
  assert.equal(current.outcome, null);
  assert.equal(current.lastMessagePreview, "handled flaky");

  const transcript = readTranscript(record.id, "claude-code");
  // The operator asked once and sees one prompt, one explained failure that
  // announces the replay, and the answer the replay produced.
  assert.equal(transcript.filter((event) => event.type === "user_message").length, 1);
  const failed = transcript.filter((event) => event.type === "result" && event.is_error === true);
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].errors, ["API Error: 500 Internal Server Error"]);
  assert.equal(failed[0].retry_scheduled, 1);
  assert.equal(failed[0].retry_max, 2);
});

test("a failure only a human can fix is reported instead of replayed", async () => {
  const record = sessions.start({
    id: "permanent-failure-session",
    prompt: "unauthorized",
    dir: fakeDir,
    agent: "claude-code",
  });
  await waitUntil(record.id, (current) => current.status === "completed");

  const current = sessions.get(record.id)!;
  assert.equal(attempts("unauthorized"), 1);
  assert.equal(current.outcome?.result, "failure");
  assert.match(current.outcome!.summary, /401 invalid api key/);

  const failed = readTranscript(record.id, "claude-code").filter((event) => event.type === "result" && event.is_error === true);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].retry_scheduled, undefined);
});
