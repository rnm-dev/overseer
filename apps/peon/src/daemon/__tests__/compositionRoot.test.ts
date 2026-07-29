import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import test from "node:test";
import type { ProjectService } from "../projects/index.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-composition-root-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-composition-root-state-"));

const { createControlServer } = await import("../controlServer.js");
const { createDaemonCompositionRoot } = await import("../bootstrap/compositionRoot.js");
const { createAgentRouter } = await import("../agentApi.js");
const { settings } = await import("../settings/index.js");
const { ProjectServiceError } = await import("../projects/index.js");

const projectServiceFixture: ProjectService = {
  list: () => [],
  detail: () => { throw new Error("detail should not be called"); },
  documentation: () => { throw new Error("documentation should not be called"); },
  document: () => { throw new Error("document should not be called"); },
  skills: () => { throw new Error("skills should not be called"); },
  listQuickLinks: () => { throw new Error("listQuickLinks should not be called"); },
  createQuickLink: () => { throw new Error("createQuickLink should not be called"); },
  updateQuickLink: () => { throw new Error("updateQuickLink should not be called"); },
  removeQuickLink: () => { throw new Error("removeQuickLink should not be called"); },
  settings: () => { throw new Error("settings should not be called"); },
  updateSettings: () => { throw new Error("updateSettings should not be called"); },
  archive: () => { throw new Error("archive should not be called"); },
  unarchive: () => { throw new Error("unarchive should not be called"); },
  archiveById: () => { throw new Error("archiveById should not be called"); },
  unarchiveById: () => { throw new Error("unarchiveById should not be called"); },
  remove: () => { throw new Error("remove should not be called"); },
  suggest: () => ({ key: "placeholder", dir: "/tmp/placeholder" }),
  start: () => ({ id: "not-used" }),
  rename: () => undefined,
};

test("composition root wires shared service instances for control and fleet entrypoints", () => {
  const composition = createDaemonCompositionRoot();

  assert.strictEqual(composition.controlServerOptions.projectService, composition.projectService);
  assert.strictEqual(composition.controlServerOptions.projectService, composition.agentRouterOptions.projectService);
  assert.strictEqual(composition.controlServerOptions.armoryRuntime, composition.armoryRuntime);
  assert.strictEqual(composition.controlServerOptions.fileAccessService, composition.fileAccessService);
  assert.strictEqual(composition.agentRouterOptions.fileAccessService, composition.fileAccessService);
});

test("control server uses injected project service for shared project routes", async () => {
  const expectedProjects = [
    { projectId: "project-id", key: "shared", label: "Shared", dir: "/tmp/shared", quickLinks: [], lastSyncedAt: 123 },
  ];
  const projectService: ProjectService = {
    ...projectServiceFixture,
    list: () => expectedProjects,
    suggest: () => ({ key: "shared", dir: "/tmp/shared" }),
  };

  const app = createControlServer({ projectService });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const port = server.address() && typeof server.address() === "object" ? server.address().port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
    const payload = (await response.json()) as { projects: typeof expectedProjects };
    assert.equal(response.status, 200);
    assert.deepEqual(payload.projects, expectedProjects);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("human project routes require injected service and keep response envelopes", async () => {
  const calls = {
    list: 0,
    detail: 0,
    create: 0,
    updateSettings: 0,
    archive: 0,
    unarchive: 0,
    remove: 0,
  };
  const createdProject = {
    projectId: "project-id",
    key: "created",
    label: "Created",
    dir: "/tmp/created",
    quickLinks: [],
    archivedAt: null,
    lastSyncedAt: 123,
    onboardingSessionId: null,
  };
  const expectedProjects = [{
    projectId: "project-id",
    key: "shared",
    label: "Shared",
    dir: "/tmp/shared",
    quickLinks: [],
    archivedAt: null,
    lastSyncedAt: 123,
  }];

  const projectService: ProjectService = {
    ...projectServiceFixture,
    list: () => {
      calls.list += 1;
      return expectedProjects;
    },
    detail: () => {
      calls.detail += 1;
      throw new ProjectServiceError(404, "UNKNOWN_PROJECT", "unknown project");
    },
    create: (_input, _author) => {
      calls.create += 1;
      return createdProject;
    },
    updateSettings: () => {
      calls.updateSettings += 1;
      throw new ProjectServiceError(400, "BAD_REQUEST", "invalid settings");
    },
    archive: () => {
      calls.archive += 1;
      return { ...createdProject, archivedAt: 123 };
    },
    unarchive: () => {
      calls.unarchive += 1;
      return { ...createdProject, archivedAt: null };
    },
    remove: () => {
      calls.remove += 1;
    },
  };

  const app = createControlServer({ projectService });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const port = server.address() && typeof server.address() === "object" ? server.address().port : 0;

    const list = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { projects: expectedProjects });

    const missing = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${encodeURIComponent("missing")}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "unknown project" });

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Created" }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), createdProject);

    const updateError = await fetch(`http://127.0.0.1:${port}/api/v1/projects/created/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    assert.equal(updateError.status, 400);
    assert.deepEqual(await updateError.json(), { error: "invalid settings", code: "BAD_REQUEST" });

    const archived = await fetch(`http://127.0.0.1:${port}/api/v1/projects/created/archive`, { method: "POST" });
    assert.equal(archived.status, 200);
    assert.equal((await archived.json() as { archivedAt: number }).archivedAt, 123);

    const restored = await fetch(`http://127.0.0.1:${port}/api/v1/projects/created/archive`, { method: "DELETE" });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json() as { archivedAt: number | null }).archivedAt, null);

    const removed = await fetch(`http://127.0.0.1:${port}/api/v1/projects/created`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });

    assert.equal(calls.list, 1);
    assert.equal(calls.detail, 1);
    assert.equal(calls.create, 1);
    assert.equal(calls.updateSettings, 1);
    assert.equal(calls.archive, 1);
    assert.equal(calls.unarchive, 1);
    assert.equal(calls.remove, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fleet router uses injected project service via control-router path", async (t) => {
  const previousToken = settings.get().overseerToken;
  t.after(() => settings.update({ overseerToken: previousToken }));
  settings.update({ overseerToken: "fleet-token" });

  const projectService: ProjectService = {
    ...projectServiceFixture,
    suggest: (label: unknown) => ({ key: String(label).toLowerCase().replace(/\s+/g, "-"), dir: "/tmp/injected" }),
  };

  const app = express();
  app.use("/api/v1", createAgentRouter({ projectService }));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const port = server.address() && typeof server.address() === "object" ? server.address().port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/suggest-dir?label=My%20Project`, {
      headers: { Authorization: "Bearer fleet-token" },
    });
    const payload = (await response.json()) as { key: string; dir: string };
    assert.equal(response.status, 200);
    assert.equal(payload.dir, "/tmp/injected");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
