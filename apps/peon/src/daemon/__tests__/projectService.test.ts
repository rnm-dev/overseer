import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECT_ONBOARDING_PROMPT, ProjectService, ProjectServiceError } from "../projects/index.js";
import { ProjectStore } from "../projects/contracts.js";

test("one project service owns views, validation, mutations, and session key propagation", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProjectStore(path.join(root, "projects.json"));
  const indexedSessions: Array<{ status: string; projectKey: string | null }> = [];
  const renames: Array<{ oldKey: string; newKey: string }> = [];
  const started: Array<{ prompt: string; dir: string; projectKey: string; author?: string }> = [];
  const titled: Array<{ id: string; title: string | null }> = [];
  const service = new ProjectService(store, {
    list: () => indexedSessions,
    renameProjectKey(oldKey, newKey) {
      renames.push({ oldKey, newKey });
      for (const session of indexedSessions) {
        if (session.projectKey === oldKey) session.projectKey = newKey;
      }
      return indexedSessions.length;
    },
    start(options) {
      started.push(options);
      return { id: "onboarding-session" };
    },
    rename(id, title) {
      titled.push({ id, title });
    },
  });

  const projectDir = path.join(root, "project");
  const created = service.create({ label: "Shared Project", dir: projectDir }, "alice@example.com");
  assert.equal(created.key, "shared-project");
  assert.equal(created.onboardingSessionId, "onboarding-session");
  assert.deepEqual(started, [{
    prompt: PROJECT_ONBOARDING_PROMPT,
    dir: projectDir,
    projectKey: "shared-project",
    author: "alice@example.com",
  }]);
  assert.deepEqual(titled, [{ id: "onboarding-session", title: "Set up project documentation" }]);
  assert.deepEqual(service.settings(created.key), {
    projectId: created.projectId,
    key: created.key,
    name: "Shared Project",
    dir: projectDir,
  });
  assert.equal(service.detail(created.key).documentation.exists, true);
  assert.deepEqual(service.list(), [{
    projectId: created.projectId,
    key: created.key,
    label: "Shared Project",
    dir: projectDir,
    quickLinks: [],
    archivedAt: null,
    lastSyncedAt: created.lastSyncedAt,
  }]);

  indexedSessions.push({ status: "completed", projectKey: created.key });
  const archived = service.archive(created.key);
  assert.equal(typeof archived.archivedAt, "number");
  assert.equal(service.archive(created.key).archivedAt, archived.archivedAt);
  assert.equal(service.unarchive(created.key).archivedAt, null);
  const updated = service.updateSettings(created.key, { key: "renamed-project", name: "Renamed Project" });
  assert.equal(updated.key, "renamed-project");
  assert.deepEqual(renames, [{ oldKey: "shared-project", newKey: "renamed-project" }]);
  assert.equal(indexedSessions[0].projectKey, "renamed-project");

  indexedSessions[0].status = "running";
  assert.throws(
    () => service.remove(updated.key),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "PROJECT_RUNNING" && error.status === 409,
  );
  indexedSessions[0].status = "completed";
  service.remove(updated.key);
  assert.throws(
    () => service.settings(updated.key),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "UNKNOWN_PROJECT" && error.status === 404,
  );
});

test("project service rejects invalid create and settings input before changing state", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-service-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProjectStore(path.join(root, "projects.json"));
  const service = new ProjectService(store, {
    list: () => [],
    renameProjectKey: () => 0,
    start: () => ({ id: "onboarding-session" }),
    rename: () => undefined,
  });

  assert.throws(
    () => service.create({ label: "---" }),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "BAD_REQUEST",
  );
  const created = service.create({ label: "Validation Project", dir: path.join(root, "project") });
  assert.throws(
    () => service.updateSettings(created.key, { dir: "relative/path" }),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "BAD_REQUEST",
  );
  assert.equal(service.settings(created.key).dir, created.dir);
});

test("project creation survives an onboarding session start failure", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-onboarding-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ProjectStore(path.join(root, "projects.json"));
  const service = new ProjectService(store, {
    list: () => [],
    renameProjectKey: () => 0,
    start: () => { throw new Error("agent unavailable"); },
    rename: () => undefined,
  });

  const created = service.create({ label: "Still Created", dir: path.join(root, "project") });

  assert.equal(created.onboardingSessionId, null);
  assert.equal(service.settings(created.key).name, "Still Created");
});

test("project quick links validate, persist, and preserve stable identity and order", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "projects.json");
  const sessionIndex = {
    list: () => [],
    renameProjectKey: () => 0,
    start: () => ({ id: "onboarding" }),
    rename: () => undefined,
  };
  const store = new ProjectStore(statePath);
  const service = new ProjectService(store, sessionIndex);
  const project = service.create({ label: "Links", dir: path.join(root, "project") });
  const first = service.createQuickLink(project.key, { title: " Docs ", url: "https://example.com/docs" });
  const second = service.createQuickLink(project.key, { title: "Issues", url: "http://example.com/issues" });
  const syncEvent = store.catalogEventsAfter(2)?.[0];
  assert.equal(syncEvent && "project" in syncEvent ? syncEvent.project.quickLinks[1]?.id : null, second.id);
  const updated = service.updateQuickLink(project.key, first.id, { title: "Documentation" });

  assert.equal(updated.id, first.id);
  assert.equal(updated.order, first.order);
  assert.deepEqual(service.listQuickLinks(project.key).links.map((link) => link.order), [0, 1]);
  service.removeQuickLink(project.key, first.id);

  const restarted = new ProjectService(new ProjectStore(statePath), sessionIndex);
  assert.deepEqual(restarted.listQuickLinks(project.key), { links: [second] });
  assert.throws(
    () => restarted.createQuickLink(project.key, { title: "Unsafe", url: "javascript:alert(1)" }),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "BAD_REQUEST",
  );
  assert.throws(
    () => restarted.updateQuickLink(project.key, "missing", { title: "Missing" }),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "UNKNOWN_QUICK_LINK",
  );
});

test("revisioned quick-link mutations reject stale project digests", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-link-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new ProjectService(new ProjectStore(path.join(root, "projects.json")), {
    list: () => [],
    renameProjectKey: () => 0,
    start: () => ({ id: "onboarding" }),
    rename: () => undefined,
  });
  const created = service.createRevisioned({ label: "Links", dir: path.join(root, "project") });
  const first = service.createQuickLinkById(
    created.projectId,
    { title: "Docs", url: "https://example.com/docs" },
    created.digest,
  );

  assert.throws(
    () => service.createQuickLinkById(
      created.projectId,
      { title: "Issues", url: "https://example.com/issues" },
      created.digest,
    ),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "PROJECT_CONFLICT",
  );
  assert.throws(
    () => service.updateQuickLinkById(
      created.projectId,
      first.link.id,
      { title: "Changed" },
      created.digest,
    ),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "PROJECT_CONFLICT",
  );
  assert.throws(
    () => service.removeQuickLinkById(created.projectId, first.link.id, created.digest),
    (error: unknown) => error instanceof ProjectServiceError && error.kind === "PROJECT_CONFLICT",
  );
});
