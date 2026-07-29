import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeLegacyProjectMetadata, ProjectStore } from "../projects/contracts.js";

test("merges every meaningful legacy project context field into Markdown", () => {
  const metadata = mergeLegacyProjectMetadata({
    metadata: "# Existing metadata\n\nKeep me.",
    info: "Push directly when asked.",
    setup: "Run with `npm run dev`.",
    publication: "Hosted by the old publisher.",
    publicationStatus: "degraded",
    publicationError: "health check failed",
    publicationRoutes: [{ key: "dashboard", publicUrl: "https://example.test" }],
  });

  assert.match(metadata ?? "", /^# Existing metadata/);
  assert.match(metadata ?? "", /## Project information\n\nPush directly when asked\./);
  assert.match(metadata ?? "", /## Local setup\n\nRun with `npm run dev`\./);
  assert.match(metadata ?? "", /## Publication/);
  assert.match(metadata ?? "", /\*\*Status:\*\* degraded/);
  assert.match(metadata ?? "", /\*\*Last error:\*\* health check failed/);
  assert.match(metadata ?? "", /"publicUrl": "https:\/\/example\.test"/);
});

test("omits empty legacy publication defaults", () => {
  assert.equal(mergeLegacyProjectMetadata({
    info: null,
    setup: null,
    publication: null,
    publicationStatus: "unpublished",
    publicationRoutes: [],
    publicationError: null,
  }), null);
});

test("backfills a stable project id once and preserves it across restarts and key changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-id-migration-"));
  const statePath = path.join(root, "config", "projects.json");
  const projectDir = path.join(root, "project");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    projects: {
      EXPO: { key: "EXPO", label: "Expo", dir: projectDir, metadata: null, lastSyncedAt: 1 },
    },
  }));

  const first = new ProjectStore(statePath);
  const backfilled = first.get("EXPO");
  assert.ok(backfilled?.projectId);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).projects.EXPO.projectId, backfilled.projectId);
  assert.match(readFileSync(path.join(projectDir, "docs", "index.md"), "utf8"), /# Expo/);

  const restarted = new ProjectStore(statePath);
  assert.equal(restarted.get("EXPO")?.projectId, backfilled.projectId);
  const renamed = restarted.update("EXPO", { key: "expo" });
  assert.equal(renamed.projectId, backfilled.projectId);

  const afterRenameRestart = new ProjectStore(statePath);
  assert.equal(afterRenameRestart.get("expo")?.projectId, backfilled.projectId);
});

test("deleting and recreating a project key allocates a new identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-id-reuse-"));
  const store = new ProjectStore(path.join(root, "projects.json"));
  const fields = { key: "reused", label: "Reused", dir: path.join(root, "project") };
  const original = store.createProject(fields);
  store.remove(fields.key);
  const recreated = store.createProject(fields);
  assert.notEqual(recreated.projectId, original.projectId);
});

test("moves stored metadata into docs and removes it from project state", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-docs-migration-"));
  const statePath = path.join(root, "projects.json");
  const projectDir = path.join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    projects: {
      legacy: { key: "legacy", label: "Legacy", dir: projectDir, metadata: "# Legacy docs\n\nKeep this.", lastSyncedAt: 1 },
    },
  }));

  new ProjectStore(statePath);

  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).projects.legacy.metadata, undefined);
  assert.equal(readFileSync(path.join(projectDir, "docs", "index.md"), "utf8"), "# Legacy docs\n\nKeep this.\n");
});
