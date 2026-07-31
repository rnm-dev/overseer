import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "../settings/settingsService.js";
import { SettingsStore } from "../settings/settingsStore.js";

function isolatedSettings(initial?: Record<string, unknown>): SettingsService {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-fleet-http-"));
  const file = path.join(root, "settings.json");
  if (initial) writeFileSync(file, JSON.stringify(initial), { mode: 0o600 });
  return new SettingsService(new SettingsStore(file));
}

test("new Peons listen for authenticated Fleet HTTP on every interface", () => {
  assert.equal(isolatedSettings().get().bindHost, "0.0.0.0");
});

test("retired topology settings cannot disable Fleet HTTP", () => {
  const service = isolatedSettings({
    fleetMode: "reverse-only",
    publicDashboardUrl: "http://127.0.0.1:9999",
    bindHost: "203.0.113.3",
  });
  assert.equal("fleetMode" in service.get(), false);
  assert.equal("publicDashboardUrl" in service.get(), false);
  assert.equal(service.get().bindHost, "203.0.113.3");
});

test("rolling clients may submit the retired field without changing listener settings", () => {
  const service = isolatedSettings({ bindHost: "203.0.113.3" });
  const { settings } = service.patchControlSettings({
    fleetMode: "reverse-only",
    publicDashboardUrl: "http://127.0.0.1:9999",
    bindHost: "203.0.113.4",
  });
  assert.equal("fleetMode" in settings, false);
  assert.equal("publicDashboardUrl" in settings, false);
  assert.equal(settings.bindHost, "203.0.113.4");
});
