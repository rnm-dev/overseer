import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectCatalog, PROJECT_CATALOG_SNAPSHOT_TTL_MS } from "../projects/index.js";
import { ProjectStore } from "../projects/contracts.js";

function fixture(): { store: ProjectStore; statePath: string; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-catalog-"));
  const statePath = path.join(root, "projects.json");
  return { store: new ProjectStore(statePath), statePath, root };
}

test("project mutations and replay journal survive restart with immutable identity", () => {
  const { store, statePath, root } = fixture();
  const created = store.createProject({ key: "alpha", label: "Alpha", dir: path.join(root, "alpha") });
  const renamed = store.update("alpha", { key: "renamed", label: "Renamed" });
  store.remove("renamed");

  const restarted = new ProjectStore(statePath);
  const state = restarted.catalogState();
  const events = restarted.catalogEventsAfter(0)!;
  assert.equal(state.latestSeq, 3);
  assert.equal(events.length, 3);
  assert.equal("project" in events[0] && events[0].project.projectId, created.projectId);
  assert.equal("project" in events[1] && events[1].project.projectId, created.projectId);
  assert.equal("project" in events[1] && events[1].project.key, "renamed");
  assert.deepEqual(events[2], { seq: 3, revision: 3, deletedProjectId: renamed.projectId });

  assert.equal(restarted.acknowledgeProjectCatalog(2), true);
  const afterAck = new ProjectStore(statePath);
  assert.deepEqual(afterAck.catalogEventsAfter(2)?.map((event) => event.seq), [3]);
  assert.equal(afterAck.catalogEventsAfter(1), null);
});

test("snapshot pages stay on one epoch, revision, and barrier while changes continue", () => {
  const { store, root } = fixture();
  store.createProject({ key: "a", label: "A", dir: path.join(root, "a") });
  store.createProject({ key: "b", label: "B", dir: path.join(root, "b") });
  const catalog = new ProjectCatalog(store);

  const first = catalog.page("snapshot", 1);
  store.update("b", { label: "Changed after barrier" });
  const second = catalog.page("snapshot", 1, first.nextCursor!);

  assert.equal(first.epoch, second.epoch);
  assert.equal(first.revision, second.revision);
  assert.equal(first.barrierSeq, second.barrierSeq);
  assert.equal(first.barrierSeq, 2);
  assert.equal(second.projects[0]?.label, "B");
  assert.deepEqual(catalog.eventsAfter(first.barrierSeq)?.map((event) => event.seq), [3]);
});

test("snapshot cursors are bounded, opaque, and expire", () => {
  const { store, root } = fixture();
  store.createProject({ key: "a", label: "A", dir: path.join(root, "a") });
  store.createProject({ key: "b", label: "B", dir: path.join(root, "b") });
  let now = 1_000;
  const catalog = new ProjectCatalog(store, () => now);
  const first = catalog.page("expiring", 1);
  assert.equal(typeof first.nextCursor, "string");
  now += PROJECT_CATALOG_SNAPSHOT_TTL_MS;
  assert.throws(() => catalog.page("expiring", 1, first.nextCursor!), /unavailable/);
  assert.throws(() => catalog.page("invalid-limit", 0), /positive integer/);
});
