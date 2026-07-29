import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "../settings/settingsStore.js";

test("a stale process cannot overwrite a credential persisted by another process", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-settings-race-"));
  const settingsPath = path.join(root, "settings.json");
  const stale = new SettingsStore(settingsPath);
  const enrolled = new SettingsStore(settingsPath);

  enrolled.update({
    overseerUrl: "https://overseer-dev.example",
    overseerToken: "pn_fresh_credential",
  });
  stale.update({ paused: true });

  const durable = new SettingsStore(settingsPath).get();
  assert.equal(durable.overseerUrl, "https://overseer-dev.example");
  assert.equal(durable.overseerToken, "pn_fresh_credential");
  assert.equal(durable.paused, true);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(settingsPath, "utf8"), /\.tmp/);
});

test("a test process cannot write settings outside the OS temp directory", () => {
  const settingsPath = path.join(process.cwd(), ".forbidden-test-settings.json");
  const store = new SettingsStore(settingsPath);

  assert.throws(
    () => store.update({ overseerToken: "pn_must_never_reach_production" }),
    /refusing to write Peon settings outside the OS temp directory during tests/,
  );
});
