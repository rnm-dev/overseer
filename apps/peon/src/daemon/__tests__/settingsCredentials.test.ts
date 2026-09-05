import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "../settings/settingsService.js";
import { SettingsStore } from "../settings/settingsStore.js";

test("human settings never expose or accept enrollment credentials", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-settings-credentials-"));
  const service = new SettingsService(new SettingsStore(path.join(root, "settings.json")));
  service.update({
    peonId: "stable-peon-id",
    overseerToken: "pn_full_admin_secret",
    pairingSecret: "single-use-pairing-secret",
    pairingSecretExpiresAt: Date.now() + 60_000,
  });

  const view = service.getControlSettingsView() as unknown as Record<string, unknown>;
  assert.equal(view.overseerToken, undefined);
  assert.equal(view.pairingSecret, undefined);
  assert.equal(view.overseerTokenSet, true);
  assert.equal(view.pairingArmed, true);
  assert.equal(view.peonId, "stable-peon-id");
  assert.equal(view.settingsDefaultsVersion, undefined);

  for (const key of ["overseerToken", "pairingSecret", "pairingSecretExpiresAt", "peonId", "strongholdToken"]) {
    assert.throws(
      () => service.patchControlSettings({ [key]: "stale-browser-value" }),
      (error: unknown) => {
        const response = error as { code?: string; error?: string };
        return response.code === "BAD_REQUEST" && response.error?.includes("managed by enrollment") === true;
      },
    );
  }
  assert.throws(
    () => service.patchControlSettings({ settingsDefaultsVersion: 99 }),
    /settingsDefaultsVersion is managed internally/,
  );
  assert.equal(service.get().overseerToken, "pn_full_admin_secret");
});

test("execution safety settings are remotely configurable with bounded validation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-settings-execution-"));
  const service = new SettingsService(new SettingsStore(path.join(root, "settings.json")));

  const { view } = service.patchDaemonConfiguration({
    maxTurns: 2_000,
    taskTimeoutMs: 3_600_000,
    maxBudgetUsd: 25.5,
  });
  assert.equal(view.maxTurns, 2_000);
  assert.equal(view.taskTimeoutMs, 3_600_000);
  assert.equal(view.maxBudgetUsd, 25.5);
  assert.deepEqual(
    (({ maxTurns, taskTimeoutMs, maxBudgetUsd }) => ({ maxTurns, taskTimeoutMs, maxBudgetUsd }))(service.get()),
    { maxTurns: 2_000, taskTimeoutMs: 3_600_000, maxBudgetUsd: 25.5 },
  );

  for (const patch of [
    { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 10_001 },
    { taskTimeoutMs: 59_999 }, { taskTimeoutMs: 86_400_001 },
    { maxBudgetUsd: -1 }, { maxBudgetUsd: Number.POSITIVE_INFINITY }, { maxBudgetUsd: 10_001 },
  ]) {
    assert.throws(() => service.patchDaemonConfiguration(patch), (error: unknown) =>
      (error as { code?: string }).code === "BAD_REQUEST");
  }
});
