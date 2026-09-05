import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeLoginService } from "../agents/claudeLogin.js";
import { CodexLoginService } from "../agents/codexLogin.js";

const temp = mkdtempSync(path.join(os.tmpdir(), "peon-login-api-"));
process.env.XDG_CONFIG_HOME = path.join(temp, "config");
process.env.XDG_STATE_HOME = path.join(temp, "state");
process.env.XDG_DATA_HOME = path.join(temp, "data");
const { createControlServer } = await import("../controlServer.js");
const { settings } = await import("../settings/index.js");
const { getAgentServiceDriver } = await import("../agents/index.js");
settings.update({ overseerToken: "login-test-token" });
const terminal = () => ({ write() {}, async stop() {} });
const claude = new ClaudeLoginService({ command: () => "unused", terminal });
const codex = new CodexLoginService({ command: () => "unused", terminal });
getAgentServiceDriver("claude-code")!.services.claudeLogin = claude;
getAgentServiceDriver("codex")!.services.codexLogin = codex;
const server = createControlServer().listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1/driver`;
const fleet = { Authorization: "Bearer login-test-token", "Peon-Actor": "owner@example.test", "Peon-Protocol": "1" };
test.after(async () => {
  await Promise.all([claude.shutdown(), codex.shutdown()]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
});

test("provider namespaces require fleet auth and actor, hide another actor's attempt, and prevent caching", async () => {
  for (const provider of ["claude-code", "codex"]) {
    const url = `${base}/${provider}/login`;
    assert.equal((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: fleet.Authorization } })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { Origin: "https://evil.test" } })).status, 403);
    const started = await fetch(url, { method: "POST", headers: fleet });
    assert.equal(started.status, 202);
    assert.equal(started.headers.get("cache-control"), "no-store");
    const a = await started.json() as { id: string };
    const other = { ...fleet, "Peon-Actor": "other@example.test" };
    assert.equal((await fetch(`${url}/${a.id}`, { headers: other })).status, 404);
    assert.equal((await fetch(url, { method: "POST", headers: other })).status, 409);
    const current = await fetch(url, { headers: fleet });
    assert.equal(((await current.json()) as { attempt: { id: string } }).attempt.id, a.id);
    const cancelled = await fetch(`${url}/${a.id}`, { method: "DELETE", headers: fleet });
    assert.equal(((await cancelled.json()) as { status: string }).status, "cancelled");
    assert.equal((await fetch(`${url}/${a.id}/code`, { method: "POST", headers: { ...fleet, "Content-Type": "application/json" }, body: '{"code":"x"}' })).status, provider === "claude-code" ? 409 : 404);
  }
});

test("local CLI can start and cancel an attempt and arbitrary commands cannot be supplied", async () => {
  const url = `${base}/claude-code/login`;
  const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"command":"arbitrary"}' });
  assert.equal(invalid.status, 400);
  const start = await fetch(url, { method: "POST" });
  assert.equal(start.status, 202);
  const a = await start.json() as { id: string };
  assert.equal((await fetch(`${url}/${a.id}`, { headers: fleet })).status, 404);
  assert.equal((await fetch(`${url}/${a.id}`, { method: "DELETE" })).status, 200);
});
