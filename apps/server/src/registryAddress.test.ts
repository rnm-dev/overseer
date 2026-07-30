import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb } from "./db.js";
import { baseUrl, legacyCallbackUrl, registry } from "./registry.js";

async function freshDb(): Promise<void> {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
}

const registration = (overrides: Partial<Parameters<typeof registry.register>[0]> = {}) => ({
  peonId: "stable-uuid",
  credentialId: "credential-1",
  workspaceId: "workspace-1",
  name: "Peon name",
  hostname: "machine-hostname",
  address: "100.64.1.20",
  controlPort: 4570,
  publicUrl: null,
  protocol: 1,
  capabilities: ["sessions"],
  token: "pn_token",
  load: { activeSessions: 0, paused: false, uptimeSec: 123 },
  ...overrides,
});

test("paired domain survives registration source IP, advertised URL, and old Peons", async () => {
  await freshDb();
  await registry.confirmPairing({
    peonId: "stable-uuid", credentialId: "credential-1", workspaceId: "workspace-1",
    token: "pn_token", publicUrl: "http://peon.example:4570",
  });

  for (const publicUrl of ["http://peon.example:4570", null]) {
    const record = await registry.register(registration({ publicUrl }));
    assert.equal(baseUrl(record), "http://peon.example:4570");
    assert.equal(record.address, "peon.example");
    assert.equal(record.addressSource, "paired");
  }
});

test("manual domain survives registration, heartbeat, and a fresh registry read", async () => {
  await freshDb();
  await registry.register(registration({ hostname: null }));
  const edited = await registry.updateConnection("stable-uuid", "https://manual.example:8443");
  assert.equal(edited?.addressSource, "manual");

  await registry.register(registration({ publicUrl: "http://advertised.example:4570" }));
  await registry.heartbeat("stable-uuid", "credential-1", { activeSessions: 1, paused: false, uptimeSec: 200 });
  const afterRestart = await registry.get("stable-uuid");
  assert.equal(afterRestart && baseUrl(afterRestart), "https://manual.example:8443");
  assert.equal(afterRestart?.addressSource, "manual");
});

test("discovery-only Peon falls back to source IP and can be promoted by legacy hostname", async () => {
  await freshDb();
  const discovered = await registry.register(registration({ hostname: null }));
  assert.equal(baseUrl(discovered), "http://100.64.1.20:4570");
  assert.equal(discovered.addressSource, "discovered");

  const legacy = await registry.register(registration({ hostname: "legacy-hostname", publicUrl: null }));
  assert.equal(baseUrl(legacy), "http://legacy-hostname:4570");
  assert.equal(legacy.addressSource, "advertised");
});

test("a reverse-only Peon may have no callback address and cannot synthesize one", () => {
  const reverseOnly = registration({
    hostname: null,
    address: "",
    controlPort: 0,
    publicUrl: null,
  });
  const record = {
    ...reverseOnly,
    addressSource: "discovered" as const,
    connectionPinned: false,
    registeredAt: 1,
    lastSeen: 1,
  };
  assert.equal(legacyCallbackUrl(record), null);
  assert.throws(() => baseUrl(record), /has no legacy callback address/);
});

test("registration racing enrollment produces one row and preserves paired URL", async () => {
  await freshDb();
  await Promise.all([
    registry.register(registration()),
    registry.confirmPairing({
      peonId: "stable-uuid", credentialId: "credential-1", workspaceId: "workspace-1",
      token: "pn_token", publicUrl: "http://peon.example:4570",
    }),
  ]);
  const records = await registry.list("workspace-1");
  assert.equal(records.length, 1);
  assert.equal(baseUrl(records[0]), "http://peon.example:4570");
  assert.equal(records[0].addressSource, "paired");
});
