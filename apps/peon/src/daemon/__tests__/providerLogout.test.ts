import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeLoginService } from "../agents/claudeLogin.js";
import { CodexLoginService } from "../agents/codexLogin.js";
import { runTerminalCommand, type TerminalFactory, type TerminalOptions } from "../agents/terminalHarness.js";

for (const [name, Service, args] of [["Claude", ClaudeLoginService, ["auth", "logout"]], ["Codex", CodexLoginService, ["logout"]]] as const) {
  test(`${name} logout uses its CLI, excludes concurrent auth and clears attempts`, async () => {
    const runs: TerminalOptions[] = [];
    let stopped = 0; let refreshed = 0;
    const terminal: TerminalFactory = (options) => { runs.push(options); return { write() {}, stop: async () => { stopped++; } }; };
    const service = new Service({ command: () => "custom-cli", terminal, onLogout: () => { refreshed++; } });
    try {
      const attempt = service.start("owner");
      await assert.rejects(service.logout(), /current authentication/);
      service.cancel("owner", attempt.id);
      await new Promise((resolve) => setImmediate(resolve));
      const pending = service.logout();
      assert.deepEqual(runs.at(-1)!.args, args);
      assert.equal(runs.at(-1)!.command, "custom-cli");
      assert.throws(() => service.start("owner"), /Sign-out is in progress/);
      await assert.rejects(service.logout(), /current authentication/);
      runs.at(-1)!.onExit(0);
      await pending;
      assert.equal(refreshed, 1); assert.equal(service.current("owner"), null);
      assert(stopped >= 2);
      const failed = service.logout();
      runs.at(-1)!.onExit(1);
      await assert.rejects(failed, /Could not sign out/);
      assert.equal(refreshed, 1);
    } finally { await service.shutdown(); }
  });
}

test("logout command timeout stops its process and discards provider output", async () => {
  let stopped = false;
  const terminal: TerminalFactory = (options) => {
    options.onData("secret"); options.onStderr?.("secret");
    return { write() {}, async stop() { stopped = true; } };
  };
  await assert.rejects(runTerminalCommand("fake", ["logout"], terminal, 10), /timed out/);
  assert.equal(stopped, true);
});
