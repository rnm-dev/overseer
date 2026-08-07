import assert from "node:assert/strict";
import test from "node:test";
import { effectiveAgentForAdmission } from "./routes/peons/sessions.js";

const catalog = {
  defaultAgent: "codex-app-server",
  providers: [
    { agent: "claude-code", models: [{ id: "claude-sonnet-5", alias: "sonnet" }] },
    { agent: "codex-app-server", models: [{ id: "gpt-5.6-sol", alias: "sol" }] },
  ],
};

test("session admission uses the advertised default agent when the request leaves it implicit", () => {
  assert.equal(effectiveAgentForAdmission(catalog, undefined, undefined), "codex-app-server");
});

test("session admission resolves an explicit model to its provider before checking auth", () => {
  assert.equal(effectiveAgentForAdmission(catalog, undefined, "gpt-5.6-sol"), "codex-app-server");
  assert.equal(effectiveAgentForAdmission(catalog, undefined, "sonnet"), "claude-code");
});

test("an explicit agent remains authoritative", () => {
  assert.equal(effectiveAgentForAdmission(catalog, "claude-code", "gpt-5.6-sol"), "claude-code");
});
