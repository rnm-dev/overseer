import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-attribution-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-attribution-state-"));

const { normalizeStoredAgentEvent } = await import("../agents/index.js");
const { readTranscript, summaryPath } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");

settings.update({ agentCommand: "/usr/bin/true", taskTimeoutMs: 1_000 });

async function waitUntilCompleted(id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (sessions.get(id)?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not complete`);
}

test("each human message retains its request actor and command id", async () => {
  const record = sessions.start({
    id: "attributed-session",
    prompt: "Investigate the failed build",
    dir: os.tmpdir(),
    author: "alice@example.com",
    commandId: "command-1",
  });
  assert.equal(record.initiator, "alice@example.com");
  await waitUntilCompleted(record.id);

  sessions.resume(record.id, "Also check the deploy logs", [], undefined, "bob@example.com", undefined, undefined, "command-2");
  await waitUntilCompleted(record.id);
  sessions.resume(record.id, "Check the original failure again", [], undefined, "alice@example.com");
  await waitUntilCompleted(record.id);

  assert.equal(sessions.get(record.id)?.initiator, "alice@example.com");
  assert.deepEqual(
    readTranscript(record.id, "claude-code")
      .filter((event) => event.type === "user_message")
      .map((event) => [event.text, event.author, event.commandId]),
    [
      ["Investigate the failed build", "alice@example.com", "command-1"],
      ["Also check the deploy logs", "bob@example.com", "command-2"],
      ["Check the original failure again", "alice@example.com", undefined],
    ],
  );

  // Both identities are on disk, not reconstructed from mutable process state.
  const persisted = JSON.parse(readFileSync(summaryPath(record.id), "utf8"));
  assert.equal(persisted.initiator, "alice@example.com");
});

test("legacy and unauthored user messages remain readable without fabricated identity", () => {
  assert.deepEqual(normalizeStoredAgentEvent("claude-code", { type: "user_message", text: "legacy" }), {
    type: "user_message",
    text: "legacy",
  });
  assert.deepEqual(
    normalizeStoredAgentEvent("claude-code", {
      type: "user_message",
      text: "attributed",
      author: "alice@example.com",
      commandId: "command-3",
    }),
    { type: "user_message", text: "attributed", author: "alice@example.com", commandId: "command-3" },
  );
});
