import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentEvent, AgentRunOptions } from "../agents/index.js";
import {
  buildCodexArgs,
  createCodexEventNormalizer,
  MAX_EDIT_DIFF_BYTES,
  MAX_EDIT_DIFF_LINE_BYTES,
  normalizeCodexFileChanges,
} from "../agents/codex.js";
import { CODEX_OUTCOME_SCHEMA } from "../sessionPrompts.js";
import { createClaudeCodeEventNormalizer, normalizeClaudeCodeEvent } from "../agents/claudeCode.js";

const opts = {
  agent: "codex", command: "codex", prompt: "", cwd: "/workspace",
  systemPromptAppend: "", sessionId: "test",
} satisfies AgentRunOptions;

function editEvent(item: Record<string, unknown>): AgentEvent[] {
  const events: AgentEvent[] = [];
  createCodexEventNormalizer(opts)({ type: "item.completed", item: { type: "file_change", id: "item_9", ...item } }, (event) => events.push(event));
  return events;
}

test("initial and resumed Codex outcome runs pass the output schema path", () => {
  const outcomeOpts = { ...opts, outcomeSchema: CODEX_OUTCOME_SCHEMA, outcomeSchemaPath: "/tmp/outcome.json" };
  assert.deepEqual(buildCodexArgs(outcomeOpts).slice(-3), ["--output-schema", "/tmp/outcome.json", "-"]);
  const resumed = buildCodexArgs({ ...outcomeOpts, resume: true, backendSessionId: "thread-1" });
  assert.equal(resumed[0], "exec");
  assert.equal(resumed[1], "resume");
  assert.ok(resumed.includes("/tmp/outcome.json"));
  assert.deepEqual(resumed.slice(-2), ["thread-1", "-"]);
  assert.ok(!buildCodexArgs(opts).includes("--output-schema"));
});

test("Codex MCP args clear inherited environment-backed headers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-codex-mcp-"));
  const configPath = path.join(dir, "mcp.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      remote_tools: {
        url: "https://tools.example.test/mcp",
        headers: { "X-Api-Key": "test_key" },
      },
    },
  }));
  try {
    const args = buildCodexArgs({ ...opts, mcpConfigPath: configPath });
    assert.ok(args.includes("mcp_servers.remote_tools.env_http_headers={}"));
    assert.ok(args.includes('mcp_servers.remote_tools.http_headers={"X-Api-Key"="test_key"}'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex normalizes every terminal result and nullable preview representation", () => {
  for (const result of ["success", "failure", "needs_human"] as const) {
    for (const previewPath of ["/tmp/preview.md", null] as const) {
      const events: AgentEvent[] = [];
      const normalize = createCodexEventNormalizer({ ...opts, outcomeSchema: CODEX_OUTCOME_SCHEMA });
      const structured = { result, summary: `${result} summary`, previewPath };
      normalize({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(structured) } }, (e) => events.push(e));
      normalize({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4 } }, (e) => events.push(e));
      assert.deepEqual(events.at(-1)?.structured_output, structured);
    }
  }
});

test("preserves exact per-invocation unified diffs for all change kinds", () => {
  const changes = [
    { path: "/workspace/a.ts", kind: "update", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old \n+new  \n" },
    { path: "/workspace/new.ts", kind: "add", diff: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n" },
    { path: "/workspace/gone.ts", kind: "delete", diff: "--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n" },
    { oldPath: "/workspace/old.ts", path: "/workspace/moved.ts", kind: "rename", diff: "--- a/old.ts\n+++ b/moved.ts\n@@ -1 +1 @@\n-x\n+x\n" },
  ];
  const events = editEvent({ status: "completed", changes });
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((event) => (event.message as any).content[0].input.changes[0]), changes.map((change) => ({
    ...change,
    path: change.path.replace("/workspace/", ""),
    ...(Object.hasOwn(change, "oldPath") ? { oldPath: change.oldPath!.replace("/workspace/", "") } : {}),
  })));
  assert.deepEqual(events.map((event) => (event.message as any).content[0].id), ["item_9", "item_9:2", "item_9:3", "item_9:4"]);
});

test("sequential edits retain distinct invocation patches including final-newline changes", () => {
  const normalize = createCodexEventNormalizer(opts);
  const events: AgentEvent[] = [];
  normalize({ type: "item.completed", item: { type: "file_change", id: "one", changes: [{ path: "/workspace/a", kind: "update", diff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n" }] } }, (e) => events.push(e));
  normalize({ type: "item.completed", item: { type: "file_change", id: "two", changes: [{ path: "/workspace/a", kind: "update", diff: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-y\n\\ No newline at end of file\n+z\n" }] } }, (e) => events.push(e));
  assert.match((events[0].message as any).content[0].input.changes[0].diff, /-x\n\+y/);
  assert.match((events[1].message as any).content[0].input.changes[0].diff, /No newline at end of file/);
});

test("accepts runtime patch aliases and marks old runtimes explicitly", () => {
  assert.equal(normalizeCodexFileChanges({ changes: [{ path: "/tmp/a", kind: "add", patch: "PATCH" }] })[0].diff, "PATCH");
  assert.equal(normalizeCodexFileChanges({ changes: [{ path: "/tmp/a", kind: "update" }] })[0].diffUnavailable, "runtime_did_not_expose_patch");
});

test("uses project-relative paths without disguising external paths", () => {
  const changes = normalizeCodexFileChanges({ changes: [
    { path: "/workspace/src/a.ts", kind: "update", diff: "patch-a" },
    { oldPath: "/workspace/old.ts", path: "/workspace/src/new.ts", kind: "rename", diff: "patch-b" },
    { path: "/shared/outside.ts", kind: "update", diff: "patch-c" },
  ] }, "/workspace");
  assert.equal(changes[0].path, "src/a.ts");
  assert.equal(changes[1].oldPath, "old.ts");
  assert.equal(changes[1].path, "src/new.ts");
  assert.equal(changes[2].path, "/shared/outside.ts");
});

test("uses the same relative-path policy for Claude Read and Write tools", () => {
  const event = normalizeClaudeCodeEvent({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "read", name: "Read", input: { file_path: "/workspace/src/a.ts" } },
      { type: "tool_use", id: "write", name: "Write", input: { file_path: "/workspace/out.txt", content: "x" } },
      { type: "tool_use", id: "external", name: "Read", input: { file_path: "/shared/a.ts" } },
    ] },
  }, "/workspace");
  const content = (event!.message as any).content;
  assert.equal(content[0].input.file_path, "src/a.ts");
  assert.equal(content[1].input.file_path, "out.txt");
  assert.equal(content[2].input.file_path, "/shared/a.ts");
});

test("Claude applies the Codex payload guard to tool results", () => {
  const events: AgentEvent[] = [];
  const normalize = createClaudeCodeEventNormalizer(
    { ...opts, agent: "claude-code", command: "claude" },
    (sessionId, toolUseId, content, source) => ({
      content: `${content} [guarded]`,
      warning: {
        sessionId,
        code: "payload_truncated",
        source: source ?? "tool_output",
        currentBytes: 100,
        limitBytes: 80,
        retainedBytes: 50,
        message: `Guarded ${toolUseId}`,
      },
    }),
  );
  normalize({
    type: "user",
    timestamp: "2026-07-16T08:06:23.942Z",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "large output" }] },
  }, (event) => events.push(event));

  assert.equal((events[0].message as any).content[0].content, "large output [guarded]");
  assert.equal(events[1].type, "warning");
  assert.equal(events[1].sourceTimestamp, "2026-07-16T08:06:23.942Z");
  assert.equal(events[1].message, "Guarded tool-1");
});

test("preserves valid provider timestamps as optional provenance", () => {
  const timestamp = "2026-07-16T08:06:23.942Z";
  const claude = normalizeClaudeCodeEvent({ type: "assistant", timestamp, message: { content: [] } });
  assert.equal(claude?.sourceTimestamp, timestamp);

  const codexEvents: AgentEvent[] = [];
  createCodexEventNormalizer(opts)(
    { type: "item.completed", timestamp, item: { type: "command_execution", id: "tool", command: "pwd" } },
    (event) => codexEvents.push(event),
  );
  assert.equal(codexEvents.length, 2);
  assert.ok(codexEvents.every((event) => event.sourceTimestamp === timestamp));
  assert.equal(normalizeClaudeCodeEvent({ type: "system", timestamp: "not-a-time" })?.sourceTimestamp, undefined);
  assert.equal(normalizeClaudeCodeEvent({ type: "system", timestamp: "2026-02-31T08:00:00Z" })?.sourceTimestamp, undefined);
});

test("caps invocation bytes and individual line length with metadata", () => {
  const huge = `--- a/a\n+++ b/a\n@@ -1 +1 @@\n-${"x".repeat(MAX_EDIT_DIFF_BYTES)}\n+z\n`;
  const [change] = normalizeCodexFileChanges({ changes: [{ path: "/tmp/a", kind: "update", diff: huge }] });
  assert.ok(Buffer.byteLength(change.diff as string) <= MAX_EDIT_DIFF_BYTES);
  assert.ok(Math.max(...(change.diff as string).split("\n").map((line) => Buffer.byteLength(line))) <= MAX_EDIT_DIFF_LINE_BYTES);
  assert.equal(change.diffTruncated, true);
  assert.equal(change.diffOriginalBytes, Buffer.byteLength(huge));
});

test("failed edits preserve errors and distinguish no-op from partial failure", () => {
  const noChange = editEvent({ status: "failed", changes: [], error: { message: "denied" } });
  assert.deepEqual((noChange[0].message as any).content[0].input.changes, []);
  assert.equal((noChange[1].message as any).content[0].content, "denied");

  const partial = editEvent({ status: "failed", changes: [{ path: "/tmp/a", kind: "add", diff: "--- /dev/null\n+++ b/a\n" }] });
  assert.equal((partial[0].message as any).content[0].input.partial, true);
  assert.equal((partial[0].message as any).content[0].input.changes[0].diff, "--- /dev/null\n+++ b/a\n");
});
