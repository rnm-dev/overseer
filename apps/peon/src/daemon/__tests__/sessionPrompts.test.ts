import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectRecord } from "../projects/contracts.js";
import { buildSystemPrompt, CODEX_OUTCOME_SCHEMA, OUTCOME_SCHEMA } from "../sessions/sessionPrompts.js";

function assertStrictObjectSchemas(schema: unknown, location = "root"): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  if (node.type === "object") {
    const properties = node.properties as Record<string, unknown> | undefined;
    assert.ok(properties, `${location} has properties`);
    assert.deepEqual(
      new Set(node.required as string[] | undefined),
      new Set(Object.keys(properties)),
      `${location}.required contains every property and no extras`,
    );
    assert.equal(node.additionalProperties, false, `${location} remains closed`);
    for (const [key, child] of Object.entries(properties)) {
      assertStrictObjectSchemas(child, `${location}.properties.${key}`);
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[keyword])) {
      node[keyword].forEach((child, index) => assertStrictObjectSchemas(child, `${location}.${keyword}[${index}]`));
    }
  }
  if (node.items) assertStrictObjectSchemas(node.items, `${location}.items`);
}

test("Codex outcome schema satisfies the recursive strict-object invariant", () => {
  assertStrictObjectSchemas(CODEX_OUTCOME_SCHEMA);
  assert.deepEqual(CODEX_OUTCOME_SCHEMA.properties.previewPath.type, ["string", "null"]);
  assert.deepEqual(CODEX_OUTCOME_SCHEMA.properties.result.enum, ["success", "failure", "needs_human"]);
});

test("Claude Code outcome schema remains unchanged", () => {
  assert.deepEqual(OUTCOME_SCHEMA.required, ["result", "summary"]);
  assert.deepEqual(OUTCOME_SCHEMA.properties.previewPath, { type: "string" });
});

const project: ProjectRecord = {
  projectId: "project-id",
  key: "peon",
  label: "Peon",
  dir: "/workspace/peon",
  lastSyncedAt: 123,
};

test("points linked sessions at the filesystem-backed documentation index", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews", project);

  assert.match(prompt, /Project documentation lives in \/workspace\/peon\/docs/);
  assert.match(prompt, /read\s+docs\/index\.md first/);
  assert.match(prompt, /Keep durable project\s+documentation in docs\//);
  assert.match(prompt, /When the user asks you to remember\s+project information or instructions, persist them in docs\//);
  assert.match(prompt, /Put critical instructions and processes that should apply to every task directly in\s+docs\/index\.md/);
  assert.match(prompt, /index is injected into every linked session's main prompt/);
  assert.match(prompt, /paths relative to the document containing\s+the link/);
  assert.match(prompt, /normalized target remains inside docs\//);
  assert.match(prompt, /Do not use absolute\s+filesystem paths or file:\/\/ URLs/);
  assert.match(prompt, /Relative \.\.\/ segments are\s+valid only when they still resolve within docs\//);
  assert.match(prompt, /external https:\/\/ links are allowed/);
  assert.match(prompt, /verify that every modified local cross-reference resolves to\s+an existing file inside docs\//);
  assert.doesNotMatch(prompt, /Project metadata/);
  assert.doesNotMatch(prompt, /"lastSyncedAt"/);
});

test("injects the current project documentation index into the main prompt", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-prompt-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "index.md"), "# Working agreement\n\nAlways run the smoke test.\n");
  const linkedProject = { ...project, dir };

  const prompt = buildSystemPrompt(false, [], "/tmp/previews", linkedProject);

  assert.match(prompt, /Project documentation index \(docs\/index\.md, injected into the main prompt\):/);
  assert.match(prompt, /# Working agreement\n\nAlways run the smoke test\./);
});

test("keeps building prompts when the project documentation index is missing", () => {
  const linkedProject = {
    ...project,
    dir: path.join(os.tmpdir(), `peon-missing-docs-${process.pid}-${Date.now()}`),
  };

  const prompt = buildSystemPrompt(false, [], "/tmp/previews", linkedProject);

  assert.match(prompt, /Project documentation lives/);
  assert.doesNotMatch(prompt, /Project documentation index \(/);
});

test("does not inject project documentation guidance into an unlinked session", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews");

  assert.doesNotMatch(prompt, /Project documentation lives/);
  assert.doesNotMatch(prompt, /docs\/index\.md/);
  assert.doesNotMatch(prompt, /documentation cross-references/);
});

test("injects the trimmed Peon soul before project documentation guidance", () => {
  const prompt = buildSystemPrompt(
    false,
    [],
    "/tmp/previews",
    project,
    "  Be candid, practical, and quietly persistent.  ",
  );

  const soulAt = prompt.indexOf("Peon soul (Markdown):");
  const projectAt = prompt.indexOf("Project documentation lives");
  assert.ok(soulAt > 0);
  assert.ok(projectAt > soulAt);
  assert.match(prompt, /Be candid, practical, and quietly persistent\./);
  assert.doesNotMatch(prompt, /  Be candid/);
});

test("omits an empty Peon soul", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews", undefined, "  \n  ");
  assert.doesNotMatch(prompt, /Peon soul/);
});

test("injects the current Peon user and explains first-person ownership", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews", project, undefined, "alice");

  assert.match(prompt, /The current Peon user is alice\./);
  assert.match(prompt, /use alice as their\s+identity/);
  assert.match(prompt, /assignee when they ask you to assign a task to them/);
});

test("omits current-user context for unattributed automation", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews", project);

  assert.doesNotMatch(prompt, /current Peon user/);
  assert.doesNotMatch(prompt, /first-person language/);
});

test("routes user-visible root delegation through durable Peon child sessions", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews", project, undefined, "alice", true);

  assert.match(prompt, /use the Peon session tools/);
  assert.match(prompt, /peon_sessions\.spawn_sessions/);
  assert.match(prompt, /model or\s+reasoning effort/);
  assert.match(prompt, /durable, visible in Overseer/);
  assert.match(prompt, /Do not use provider-native sub-agents for user-visible delegation/);
  assert.match(prompt, /explicitly asks for ephemeral internal\s+parallelism/);
});

test("does not advertise spawning to delegated child sessions", () => {
  const prompt = buildSystemPrompt(false, [], "/tmp/previews", project, undefined, "alice", false);

  assert.doesNotMatch(prompt, /peon_sessions\.spawn_sessions/);
  assert.doesNotMatch(prompt, /provider-native sub-agents/);
});

test("does not instruct agents to create or hand off preview artifacts", () => {
  for (const expectsOutcome of [false, true]) {
    const prompt = buildSystemPrompt(expectsOutcome, [], "/tmp/previews");
    assert.doesNotMatch(prompt, /Open preview/i);
    assert.doesNotMatch(prompt, /previewPath/i);
    assert.doesNotMatch(prompt, /peon-previews/i);
    assert.doesNotMatch(prompt, /user-facing artifact/i);
  }
});
