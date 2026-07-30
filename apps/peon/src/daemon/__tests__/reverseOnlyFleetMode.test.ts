import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPeonRegistrar } from "../overseer/peonRegistrar.js";
import { SettingsService } from "../settings/settingsService.js";
import { SettingsStore } from "../settings/settingsStore.js";

function isolatedSettings(initial?: Record<string, unknown>): SettingsService {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-reverse-only-"));
  const file = path.join(root, "settings.json");
  if (initial) writeFileSync(file, JSON.stringify(initial), { mode: 0o600 });
  return new SettingsService(new SettingsStore(file));
}

test("existing settings safely migrate to explicit legacy-mesh compatibility", () => {
  const service = isolatedSettings({ bindHost: "0.0.0.0", overseerUrl: "https://overseer.test" });
  assert.equal(service.get().fleetMode, "legacy-mesh");
  assert.equal(service.get().bindHost, "0.0.0.0");
});

test("reverse-only selection atomically restores IPv4 loopback local URLs", () => {
  const service = isolatedSettings();
  const { settings } = service.patchControlSettings({
    fleetMode: "reverse-only",
    bindHost: "0.0.0.0",
    publicControlUrl: "https://peon.example.test",
    publicDashboardUrl: "https://peon.example.test",
  });
  assert.equal(settings.fleetMode, "reverse-only");
  assert.equal(settings.bindHost, "127.0.0.1");
  assert.match(settings.publicControlUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.match(settings.publicDashboardUrl, /^http:\/\/127\.0\.0\.1:/);
});

test("reverse-only rejects a later non-loopback listener until compatibility mode is explicit", () => {
  const service = isolatedSettings({ fleetMode: "reverse-only" });
  assert.throws(
    () => service.patchControlSettings({ bindHost: "0.0.0.0" }),
    /switch fleetMode to legacy-mesh/,
  );
  assert.equal(service.patchControlSettings({ fleetMode: "legacy-mesh", bindHost: "0.0.0.0" }).settings.bindHost, "0.0.0.0");
});

test("reverse-only registrar performs no callback registration or heartbeat", async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("unexpected inbound callback registration");
  };
  try {
    const registrar = createPeonRegistrar({
      readSettings: () => ({
        fleetMode: "reverse-only",
        name: "nat-peon",
        overseerUrl: "https://overseer.test",
        overseerToken: "secret",
        fileTransferRoot: "",
        heartbeatIntervalMs: 60_000,
        paused: false,
      }),
      subscribe: () => () => undefined,
    });
    registrar.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetches, 0);
    assert.deepEqual(registrar.getState(), {
      enabled: false,
      registered: false,
      derecruited: false,
      lastRegisteredAt: null,
      lastHeartbeatAt: null,
      lastError: null,
      mode: "reverse-only",
      publicUrl: null,
    });
    registrar.stop();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
