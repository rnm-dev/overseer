import assert from "node:assert/strict";
import test from "node:test";
import { buildContinuationSessionRequest, continuationRecoveryPrompt, lastUnexecutedUserPrompt, sessionContinuationFailure } from "./sessionContinuationRecovery";

test("classifies Codex thread preparation failures", () => {
  assert.equal(sessionContinuationFailure({ type: "result", is_error: true, errors: ["Codex app-server request thread/fork timed out after 30000ms"] }), "fork_timeout");
  assert.equal(sessionContinuationFailure({ type: "result", is_error: true, errors: ["invalid paginated history lineage for abc: missing source rollout"] }), "missing_history");
  assert.equal(sessionContinuationFailure({ type: "result", is_error: true, errors: ["Codex app-server thread/fork failed: failed to prepare paginated fork: thread-store internal error: durable rollout shrank before projection"] }), "missing_history");
  assert.equal(sessionContinuationFailure({ type: "result", is_error: true, errors: ["turn/start failed"] }), null);
});

test("continuation session preserves project, directory, agent, model, and effort", () => {
  const body = buildContinuationSessionRequest({
    sourceSessionId: "session-1", sourceUrl: "https://example.test/session-1", prompt: "continue",
    projectKey: "overseer", dir: "/work/overseer", agent: "codex", model: "gpt-5", reasoningEffort: "high",
  });
  assert.equal(body.projectKey, "overseer");
  assert.equal(body.dir, "/work/overseer");
  assert.equal(body.agent, "codex");
  assert.equal(body.model, "gpt-5");
  assert.equal(body.reasoningEffort, "high");
});

test("recovery carries the request and source reference", () => {
  const prompt = lastUnexecutedUserPrompt([{ type: "user_message", text: "old" }, { type: "user_message", text: "finish the task" }]);
  const recovery = continuationRecoveryPrompt("session-1", "https://example.test/sessions/session-1", prompt);
  assert.match(recovery, /Source Peon session: session-1/);
  assert.match(recovery, /finish the task/);
  assert.match(recovery, /Do not attempt to fork or resume/);
});
