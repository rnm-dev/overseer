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

  for (const key of ["overseerToken", "pairingSecret", "pairingSecretExpiresAt", "peonId", "strongholdToken"]) {
    assert.throws(
      () => service.patchControlSettings({ [key]: "stale-browser-value" }),
      (error: unknown) => {
        const response = error as { code?: string; error?: string };
        return response.code === "BAD_REQUEST" && response.error?.includes("managed by enrollment") === true;
      },
    );
  }
  assert.equal(service.get().overseerToken, "pn_full_admin_secret");
});
