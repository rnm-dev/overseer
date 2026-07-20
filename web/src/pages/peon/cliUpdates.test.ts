import assert from "node:assert/strict";
import test from "node:test";
import { cliUpdateBusy, normalizeCliUpdates } from "./cliUpdates";

test("normalizes keyed CLI update status and a nested durable operation", () => {
  assert.deepEqual(normalizeCliUpdates({
    updates: {
      codex: { currentVersion: "1.2.0", latestVersion: "1.3.0", checkedAt: 42, operation: { status: "running" } },
      claudeCode: { installedVersion: "2.0.0", availableVersion: "2.0.0", updateStatus: "idle" },
    },
  }), [
    { provider: "codex", currentVersion: "1.2.0", latestVersion: "1.3.0", updateAvailable: true, checkedAt: 42, status: "running", error: null },
    { provider: "claude-code", currentVersion: "2.0.0", latestVersion: "2.0.0", updateAvailable: false, checkedAt: null, status: "idle", error: null },
  ]);
});

test("normalizes an array response and ISO check times", () => {
  const [item] = normalizeCliUpdates({ tools: [{ provider: "claude-code", current: "3.0.0", latest: "3.1.0", refreshedAt: "2026-07-17T00:00:00Z" }] });
  assert.equal(item?.provider, "claude-code");
  assert.equal(item?.updateAvailable, true);
  assert.equal(item?.checkedAt, Date.parse("2026-07-17T00:00:00Z"));
});

test("only active durable states block another update", () => {
  assert.equal(cliUpdateBusy("queued"), true);
  assert.equal(cliUpdateBusy("running"), true);
  assert.equal(cliUpdateBusy("success"), false);
  assert.equal(cliUpdateBusy("failure"), false);
});
