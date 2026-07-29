import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-app-server-rollout-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-app-server-rollout-state-"));

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fakeCodexAppServer.mjs");
const workspace = mkdtempSync(path.join(os.tmpdir(), "peon-app-server-rollout-workspace-"));
const wrapper = path.join(workspace, "codex.mjs");
writeFileSync(wrapper, `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fixture).href)};\n`);
chmodSync(wrapper, 0o755);

const { shutdownAgentDriverRuntimes } = await import("../agents/index.js");
const { createControlServer } = await import("../controlServer.js");
const { readTranscript } = await import("../sessions/sessionArtifacts.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");

settings.update({ codexCommand: wrapper, defaultAgent: "codex-app-server", taskTimeoutMs: 2_000 });

const server = createControlServer().listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

async function waitForCompleted(id: string, followUpCount: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = sessions.get(id);
    if (record?.status === "completed" && record.followUpPrompts.length === followUpCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not complete follow-up ${followUpCount}`);
}

test.after(async () => {
  await shutdownAgentDriverRuntimes();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("configured rollout uses app-server end to end while persisted sessions remain pinned", async () => {
  const started = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "first", dir: workspace }),
  });
  assert.equal(started.status, 201);
  const initial = (await started.json()) as { id: string; agent: string };
  assert.equal(initial.agent, "codex-app-server");

  await waitForCompleted(initial.id, 0);
  const first = sessions.get(initial.id)!;
  assert.equal(first.backendSessionId, "thread-1");
  assert.equal(first.agent, "codex-app-server");

  const health = await fetch(`${base}/api/v1/ai/status/codex-app-server`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(typeof healthBody.startedAt, "number");
  assert.deepEqual({ ...healthBody, startedAt: null }, {
    status: "healthy",
    generation: 1,
    version: "0.144.5",
    minimumVersion: "0.144.0",
    capabilities: { experimentalApi: true },
    restartAttempts: 0,
    pendingRequests: 0,
    queuedNotifications: 0,
    lastError: null,
    startedAt: null,
  });

  settings.update({ defaultAgent: "codex" });
  const followedUp = await fetch(`${base}/api/v1/sessions/${initial.id}/followup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "second" }),
  });
  assert.equal(followedUp.status, 201);
  assert.equal(((await followedUp.json()) as { agent: string }).agent, "codex-app-server");

  await waitForCompleted(initial.id, 1);
  const resumed = sessions.get(initial.id)!;
  assert.equal(resumed.agent, "codex-app-server");
  assert.equal(resumed.backendSessionId, "thread-1");
  assert.ok(readTranscript(initial.id, "codex-app-server").some((event) =>
    event.type === "assistant" && JSON.stringify(event).includes("reply:thread-1:second")));
});
