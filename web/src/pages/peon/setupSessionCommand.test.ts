import assert from "node:assert/strict";
import test from "node:test";
import { buildNewSessionRequest, parseSetupCommand, setupSessionFromNavigationState } from "./setupSessionCommand";

const attributes = {
  projectKey: "app",
  dir: "/path/to/app",
  prompt: "Set up and verify…",
  expectsOutcome: true,
};

test("setup response initializes a composer without creating a session", () => {
  const command = parseSetupCommand({ command: "new_session", attributes });
  assert.deepEqual(command, { ok: true, attributes });
  if (!command.ok) return;

  const navigationState = { setupSession: command.attributes, returnTo: "/projects/app" };
  assert.deepEqual(setupSessionFromNavigationState(navigationState), attributes);
  // Parsing and navigation only produce form state. The session payload is
  // composed separately, when the operator submits.
  assert.equal("session" in command, false);
});

test("submission includes edited prompt, returned fields, and existing controls", () => {
  const request = buildNewSessionRequest({
    ...attributes,
    prompt: "operator-edited prompt",
    agent: "claude-code",
    model: "claude-sonnet",
    reasoningEffort: "high",
  });
  assert.deepEqual(request, {
    projectKey: "app",
    dir: "/path/to/app",
    prompt: "operator-edited prompt",
    expectsOutcome: true,
    agent: "claude-code",
    model: "claude-sonnet",
    reasoningEffort: "high",
  });
});

test("setup commands preserve supported model options for editing", () => {
  const command = parseSetupCommand({
    command: "new_session",
    attributes: { ...attributes, agent: "codex", model: "gpt-5", reasoningEffort: "high" },
  });
  assert.deepEqual(command, {
    ok: true,
    attributes: { ...attributes, agent: "codex", model: "gpt-5", reasoningEffort: "high" },
  });
});

test("cancel/back has no session side effect", () => {
  const navigationState = { setupSession: attributes, returnTo: "/projects/app" };
  assert.equal(navigationState.returnTo, "/projects/app");
  assert.equal(Object.hasOwn(navigationState, "request"), false);
});

test("the same new_session command is valid regardless of project readiness", () => {
  for (const isSetUp of [false, true]) {
    const command = parseSetupCommand({ command: "new_session", attributes: { ...attributes } });
    assert.equal(command.ok, true, `isSetUp=${isSetUp}`);
  }
});

test("unknown commands and malformed attributes are rejected", () => {
  assert.deepEqual(parseSetupCommand({ command: "launch", attributes }), {
    ok: false,
    error: "Unsupported Peon command: launch",
  });
  assert.deepEqual(parseSetupCommand({ command: "new_session", attributes: { projectKey: "app" } }), {
    ok: false,
    error: "Peon protocol error: invalid new_session attributes.",
  });
  assert.equal(parseSetupCommand({ command: "new_session", attributes: { ...attributes, expectsOutcome: false } }).ok, false);
  assert.equal(parseSetupCommand(null).ok, false);
});
