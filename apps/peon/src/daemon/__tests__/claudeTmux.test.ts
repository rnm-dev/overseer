import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ClaudeLoginService } from "../agents/claudeLogin.js";

let available = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { available = false; }
for (const mode of ["success", "cancel", "expire"] as const) {
  test(`Claude tmux login: ${mode}, TTY and cleanup`, { skip: !available }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "peon-tmux-test-"));
    const command = join(dir, "fake claude");
    await writeFile(command, `#!/usr/bin/env node
if (process.argv[3] === 'status') { console.log('{"loggedIn":true}'); process.exit(0); }
if (!process.stdin.isTTY) process.exit(2);
require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid));
console.log('https://claude.com/cai/oauth/authorize?state=test&code_challenge=test');
console.log('Paste code here:');
process.stdin.on('data', (data) => process.exit(data.toString().trim() === 'test-code#state' ? 0 : 3));
`, { mode: 0o700 });
    const service = new ClaudeLoginService({ command: () => command, ttlMs: mode === "expire" ? 1800 : 10000 });
    try {
      const a = service.start("test-owner");
      for (let i = 0; service.get("test-owner", a.id).status === "starting" && i < 100; i++) await delay(30);
      assert.equal(service.get("test-owner", a.id).status, "awaiting_code", service.get("test-owner", a.id).error ?? "no prompt");
      if (mode === "success") service.submitCode("test-owner", a.id, "test-code#state");
      if (mode === "cancel") service.cancel("test-owner", a.id);
      for (let i = 0; ["starting", "awaiting_code", "verifying"].includes(service.get("test-owner", a.id).status) && i < 200; i++) await delay(30);
      assert.equal(service.get("test-owner", a.id).status, { success: "succeeded", cancel: "cancelled", expire: "expired" }[mode]);
      assert.equal(service.get("test-owner", a.id).authorizationUrl, null);
    } finally {
      await service.shutdown();
      const pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
      if (pid) {
        for (let i = 0; i < 30; i++) {
          try { process.kill(pid, 0); await delay(30); } catch { break; }
        }
        assert.throws(() => process.kill(pid, 0), "tmux must not leave the login process alive");
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("abrupt daemon death closes the private tmux login", { skip: !available }, async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "peon-tmux-parent-test-"));
  const command = join(dir, "claude");
  await writeFile(command, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const parent = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/claudeLoginParent.mjs", import.meta.url)), command], { stdio: "ignore" });
  let pid = 0;
  try {
    for (let i = 0; !pid && i < 100; i++) {
      pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
      await delay(30);
    }
    assert(pid > 0, "login started");
    parent.kill("SIGKILL");
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); await delay(30); } catch { break; }
    }
    assert.throws(() => process.kill(pid, 0), "daemon death must close tmux's CLI");
  } finally {
    parent.kill("SIGKILL");
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
