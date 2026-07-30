import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-cli-api-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-cli-api-state-"));

const { createControlServer } = await import("../controlServer.js");

const operation = {
  id: "op-1", status: "running" as const, startedAt: 10, finishedAt: null, pid: null,
  fromVersion: "1.0.0", toVersion: null, error: null, logPath: "/tmp/op-1.log",
};
const service = {
  async get(provider?: "codex-app-server" | "claude-code", refresh?: boolean) {
    const providers = (provider ? [provider] : ["codex-app-server", "claude-code"] as const).map((item) => ({
      provider: item, currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true,
      checkedAt: refresh ? 20 : 10, checkError: null, operation: null,
    }));
    return { updatedAt: refresh ? 20 : 10, providers };
  },
  async start() { return operation; },
};
const server = createControlServer({ cliUpdates: service }).listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
test.after(() => server.close());

test("CLI update API exposes aggregate, provider, action, and validation contracts", async () => {
  const aggregate = await fetch(`${base}/api/v1/ai/cli-updates?refresh=1`);
  assert.equal(aggregate.status, 200);
  assert.equal(((await aggregate.json()) as { providers: unknown[] }).providers.length, 2);

  const provider = await fetch(`${base}/api/v1/ai/cli-updates/codex-app-server`);
  assert.equal(provider.status, 200);
  assert.equal(((await provider.json()) as { provider: string }).provider, "codex-app-server");

  const started = await fetch(`${base}/api/v1/ai/cli-updates/claude-code`, { method: "POST" });
  assert.equal(started.status, 202);
  assert.equal(((await started.json()) as { operation: { id: string } }).operation.id, "op-1");

  const unknown = await fetch(`${base}/api/v1/ai/cli-updates/other`);
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { code: string }).code, "UNKNOWN_PROVIDER");
});
