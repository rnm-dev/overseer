import assert from "node:assert/strict";
import { type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-enrollment-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-enrollment-state-"));

const { settings } = await import("../settings/index.js");
const { pairing } = await import("../identity/pairing.js");
const { createAgentRouter } = await import("../agentApi.js");
const { registrationPayload } = await import("../overseer/peonRegistrar.js");

settings.update({
  overseerToken: "",
  overseerUrl: "",
  publicControlUrl: "https://peon.example.test/",
});

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter());
const api: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => api.once("listening", resolve));
const address = api.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1/enroll`;

test.after(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
});

test("enrollment keeps the canonical domain and does not consume a phrase on configuration errors", async () => {
  const { phrase } = pairing.arm();
  const headers = {
    Authorization: `Bearer ${phrase}`,
    "Content-Type": "application/json",
    "Peon-Protocol": "1",
  };

  const invalid = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ overseerUrl: "not a URL", overseerToken: "pn_test" }),
  });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json() as { code: string; error: string };
  assert.equal(invalidBody.code, "BAD_REQUEST");
  assert.match(invalidBody.error, /complete http:\/\/ or https:\/\/ URL/);
  assert.match(invalidBody.error, /phrase was not consumed/);
  assert.equal(pairing.isArmed(), true);
  assert.equal(settings.get().overseerUrl, "");

  // Correcting form validation repeatedly is not credential guessing and must
  // not lock out the operator or consume the otherwise valid phrase.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const correction = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ overseerUrl: "still-not-a-url", overseerToken: "pn_test" }),
    });
    assert.equal(correction.status, 400);
  }
  assert.equal(pairing.isArmed(), true);

  const enrolled = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ overseerUrl: "https://overseer.example.test/", overseerToken: "pn_test" }),
  });
  assert.equal(enrolled.status, 200);
  const enrolledBody = await enrolled.json() as { ok: boolean; peonId: string; publicUrl: string };
  assert.equal(enrolledBody.ok, true);
  assert.match(enrolledBody.peonId, /^[0-9a-f-]{36}$/);
  assert.equal(enrolledBody.publicUrl, "https://peon.example.test");
  assert.equal(settings.get().overseerUrl, "https://overseer.example.test");
  assert.equal(settings.get().overseerToken, "pn_test");
  assert.equal(pairing.isArmed(), false);
  assert.equal(registrationPayload(enrolledBody.peonId).publicUrl, "https://peon.example.test");
});

test("enrollment failures tell the operator how to recover", async () => {
  settings.update({ overseerToken: "" });

  const missing = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overseerUrl: "https://overseer.example.test", overseerToken: "pn_test" }),
  });
  assert.equal(missing.status, 401);
  assert.match(((await missing.json()) as { error: string }).error, /arm a new phrase/);

  const expired = await fetch(base, {
    method: "POST",
    headers: { Authorization: "Bearer old-phrase", "Content-Type": "application/json" },
    body: JSON.stringify({ overseerUrl: "https://overseer.example.test", overseerToken: "pn_test" }),
  });
  assert.equal(expired.status, 401);
  assert.match(((await expired.json()) as { error: string }).error, /expired or already used/);
});
