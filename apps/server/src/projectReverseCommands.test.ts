import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeReverseCommandResult,
  parseProjectDocumentationSnapshot,
  type JsonObject,
  type ReverseCommandOperation,
  type ReverseCommandResultFrame,
} from "./modules/reverseCommands/index.js";

const peonId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const commandId = "00000000-0000-4000-8000-000000000003";
const linkId = "00000000-0000-4000-8000-000000000004";
const digest = "a".repeat(64);
const documentation = {
  exists: true,
  indexPath: "index.md",
  index: {
    path: "index.md", name: "index.md", title: "Home", content: "# Home\n",
    size: 7, mtimeMs: 1, truncated: false,
  },
  tree: [{ type: "file", name: "index.md", path: "index.md", size: 7, mtimeMs: 1 }],
};
const link = { id: linkId, title: "Docs", url: "https://example.com/docs", order: 0 };

function result(operation: ReverseCommandOperation, detail: JsonObject): ReverseCommandResultFrame {
  return {
    type: "command_result",
    protocol: 1,
    commandId,
    operation,
    status: "applied",
    code: "OK",
    completedAt: 1,
    result: detail,
  };
}

test("every shipped project operation has an exact safe terminal result shape", () => {
  const cases: Array<[ReverseCommandOperation, JsonObject, boolean]> = [
    ["project.create", {
      projectId, key: "alpha", label: "Alpha", dir: "/tmp/alpha", quickLinks: [],
      archivedAt: null, lastSyncedAt: 1, onboardingSessionId: null, digest,
    }, false],
    ["project.suggest-directory", { key: "alpha", dir: "/tmp/alpha" }, false],
    ["project.detail", {
      projectId, key: "alpha", label: "Alpha", dir: "/tmp/alpha", quickLinks: [],
      archivedAt: null, lastSyncedAt: 1, digest, documentation,
    }, true],
    ["project.settings.get", { projectId, key: "alpha", name: "Alpha", dir: "/tmp/alpha", digest }, true],
    ["project.settings.update", { projectId, key: "alpha", name: "Alpha", dir: "/tmp/alpha", digest }, true],
    ["project.delete", { projectId, digest }, true],
    ["project.documentation.index", {
      snapshotDigest: digest, byteOffset: 0, totalBytes: 2, chunk: "{}", cursor: "cursor", nextCursor: null,
    }, true],
    ["project.documentation.read", {
      path: "index.md", name: "index.md", title: "Home", content: "# Home\n",
      size: 7, mtimeMs: 1, truncated: false, offset: 0, nextOffset: null,
    }, true],
    ["project.skills.list", {
      skills: [{ name: "review", description: "Review safely", path: ".agents/skills/review/SKILL.md", scope: "project" }],
    }, true],
    ["project.quick-links.list", { links: [link], digest }, true],
    ["project.quick-links.create", { link, digest }, true],
    ["project.quick-links.update", { link, digest }, true],
    ["project.quick-links.delete", { projectId, linkId, digest }, true],
  ];
  for (const [operation, detail, targeted] of cases) {
    assert.doesNotThrow(
      () => assertSafeReverseCommandResult(
        { operation, target: { peonId, ...(targeted ? { projectId } : {}) } },
        result(operation, detail),
      ),
      operation,
    );
  }
});

test("project result allowlists reject sensitive extras, cross-project results, and invalid tuples", () => {
  const record = { operation: "project.settings.get" as const, target: { peonId, projectId } };
  const safe = { projectId, key: "alpha", name: "Alpha", dir: "/tmp/alpha", digest };
  assert.throws(() => assertSafeReverseCommandResult(record, result(record.operation, {
    ...safe,
    token: "must-not-persist",
  })));
  assert.throws(() => assertSafeReverseCommandResult(record, result(record.operation, {
    ...safe,
    projectId: "00000000-0000-4000-8000-000000000099",
  })));
  assert.throws(() => assertSafeReverseCommandResult(record, {
    ...result(record.operation, safe),
    status: "noop",
  }));
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, {
    ...result(record.operation, safe),
    status: "failed",
    code: "INTERNAL",
    result: null,
  }));
});

test("aggregated documentation snapshots are bounded and recursively allowlisted", () => {
  const serialized = JSON.stringify(documentation);
  assert.deepEqual(parseProjectDocumentationSnapshot(serialized), documentation);
  assert.throws(() => parseProjectDocumentationSnapshot(JSON.stringify({
    ...documentation,
    credential: "secret",
  })));
  assert.throws(() => parseProjectDocumentationSnapshot(JSON.stringify({
    ...documentation,
    tree: [{ ...documentation.tree[0], authorization: "secret" }],
  })));
});
