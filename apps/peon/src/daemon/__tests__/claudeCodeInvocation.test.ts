import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import type { AgentRunOptions } from "../agents/executor.js";
import { prepareClaudeCodeInvocation } from "../agents/claudeCode.js";

test("large Claude system prompts are passed through a private temporary file", () => {
  const systemPromptAppend = "x".repeat(140 * 1024);
  const options = {
    agent: "claude-code",
    command: "claude",
    cwd: process.cwd(),
    prompt: "hello",
    sessionId: "00000000-0000-4000-8000-000000000001",
    systemPromptAppend,
  } as AgentRunOptions;

  const invocation = prepareClaudeCodeInvocation(options);
  try {
    const flagIndex = invocation.args.indexOf("--append-system-prompt-file");
    assert.notEqual(flagIndex, -1);
    assert.equal(invocation.args[flagIndex + 1], invocation.systemPromptPath);
    assert.equal(invocation.args.includes("--append-system-prompt"), false);
    assert.equal(invocation.args.includes(systemPromptAppend), false);
    assert.equal(readFileSync(invocation.systemPromptPath, "utf8"), systemPromptAppend);
    assert.equal(statSync(invocation.systemPromptPath).mode & 0o777, 0o600);
  } finally {
    invocation.dispose();
  }
  assert.equal(existsSync(invocation.systemPromptPath), false);
});
