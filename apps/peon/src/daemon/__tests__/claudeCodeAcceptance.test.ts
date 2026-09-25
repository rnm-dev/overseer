import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeCodeEventNormalizer } from "../agents/claudeCode.js";
import type { AgentEvent, AgentRunOptions } from "../agents/index.js";

test("Claude acknowledges provider acceptance once on its first normalized stdout event", () => {
  let accepted = 0;
  const events: AgentEvent[] = [];
  const options: AgentRunOptions = {
    agent: "claude-code",
    command: "claude",
    prompt: "hello",
    cwd: "/tmp",
    systemPromptAppend: "system",
    sessionId: "session",
    onAccepted: () => { accepted += 1; },
  };
  const normalize = createClaudeCodeEventNormalizer(options);
  normalize({ type: "system", subtype: "init", session_id: "session" }, (event) => events.push(event));
  normalize({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }, (event) => events.push(event));
  assert.equal(accepted, 1);
  assert.equal(events.length, 2);
});

test("Claude does not acknowledge a setup refusal that has no init event", () => {
  let accepted = 0;
  const normalize = createClaudeCodeEventNormalizer({
    agent: "claude-code", command: "claude", prompt: "hello", cwd: "/tmp",
    systemPromptAppend: "system", sessionId: "session", onAccepted: () => { accepted += 1; },
  });
  normalize({ type: "result", is_error: true, result: "authentication required" }, () => {});
  assert.equal(accepted, 0);
});

test("Claude thinking_tokens heartbeats are not transcript events", () => {
  const events: AgentEvent[] = [];
  const normalize = createClaudeCodeEventNormalizer({
    agent: "claude-code", command: "claude", prompt: "hello", cwd: "/tmp",
    systemPromptAppend: "system", sessionId: "session",
  });
  normalize({ type: "system", subtype: "thinking_tokens", session_id: "session" }, (event) => events.push(event));
  normalize({ type: "system", subtype: "init", session_id: "session" }, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.subtype), ["init"]);
});
