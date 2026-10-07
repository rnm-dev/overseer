import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-model-selection-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-model-selection-state-"));

const { summaryPath } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");
const { discoverBuiltinFixtureModels } = await import("./helpers/cliModelCatalog.js");
await discoverBuiltinFixtureModels();

settings.update({ agentCommand: "/usr/bin/true", taskTimeoutMs: 1_000 });

async function waitUntilCompleted(id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (sessions.get(id)?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not complete`);
}

test("a follow-up's explicit model becomes the session's own default", async () => {
  const record = sessions.start({
    id: "model-selection-session",
    prompt: "Start on Sonnet",
    dir: os.tmpdir(),
    model: "claude-sonnet-5",
    reasoningEffort: "medium",
  });
  await waitUntilCompleted(record.id);

  sessions.resume(record.id, "Continue on Opus", [], undefined, undefined, "claude-opus-5", "high");
  await waitUntilCompleted(record.id);

  // The operator picked it in the composer for the conversation, not for one
  // message: every later read of the record has to agree with what ran.
  assert.equal(sessions.get(record.id)?.model, "claude-opus-5");
  assert.equal(sessions.get(record.id)?.reasoningEffort, "high");
  const persisted = JSON.parse(readFileSync(summaryPath(record.id), "utf8"));
  assert.equal(persisted.model, "claude-opus-5");
  assert.equal(persisted.reasoningEffort, "high");

  // A follow-up that names nothing inherits the pinned selection rather than
  // falling back to the daemon-wide default.
  sessions.resume(record.id, "Keep going");
  await waitUntilCompleted(record.id);
  assert.equal(sessions.get(record.id)?.model, "claude-opus-5");
  assert.equal(sessions.get(record.id)?.reasoningEffort, "high");

  // What the session was created with stays readable for spawn idempotency.
  assert.equal(sessions.get(record.id)?.createdModel, "claude-sonnet-5");
  assert.equal(sessions.get(record.id)?.createdReasoningEffort, "medium");
});

test("a session that pinned nothing keeps following the daemon default", async () => {
  const record = sessions.start({ id: "model-inheriting-session", prompt: "No model named", dir: os.tmpdir() });
  await waitUntilCompleted(record.id);

  sessions.resume(record.id, "Still none named");
  await waitUntilCompleted(record.id);

  assert.equal(sessions.get(record.id)?.model, null);
  assert.equal(sessions.get(record.id)?.reasoningEffort, null);
});
