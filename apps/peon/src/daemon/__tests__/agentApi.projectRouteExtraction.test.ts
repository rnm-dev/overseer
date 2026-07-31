import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-project-routes-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-project-routes-state-"));

const { settings } = await import("../settings/index.js");
const { createAgentRouter } = await import("../agentApi.js");
import { ProjectServiceError, type ProjectService } from "../projects/index.js";

function fakeProjectService(overrides: Partial<ProjectService>): ProjectService {
  return {
    list: () => [],
    detail: () => {
      throw new Error("detail should not be called");
    },
    suggest: () => {
      throw new Error("suggest should not be called");
    },
    create: () => {
      throw new Error("create should not be called");
    },
    documentation: () => {
      throw new Error("documentation should not be called");
    },
    document: () => {
      throw new Error("document should not be called");
    },
    skills: () => {
      throw new Error("skills should not be called");
    },
    listQuickLinks: () => {
      throw new Error("listQuickLinks should not be called");
    },
    createQuickLink: () => {
      throw new Error("createQuickLink should not be called");
    },
    updateQuickLink: () => {
      throw new Error("updateQuickLink should not be called");
    },
    removeQuickLink: () => {
      throw new Error("removeQuickLink should not be called");
    },
    settings: () => {
      throw new Error("settings should not be called");
    },
    updateSettings: () => {
      throw new Error("updateSettings should not be called");
    },
    archive: () => {
      throw new Error("archive should not be called");
    },
    unarchive: () => {
      throw new Error("unarchive should not be called");
    },
    archiveById: () => {
      throw new Error("archiveById should not be called");
    },
    unarchiveById: () => {
      throw new Error("unarchiveById should not be called");
    },
    remove: () => {
      throw new Error("remove should not be called");
    },
    start: () => ({ id: "not-used" }),
    rename: () => undefined,
    ...overrides,
  };
}

const token = "pn_fleet_project_routes_test";
settings.update({ overseerToken: token, paused: false });

const app = express();
app.use(express.json());

const callLog = {
  list: 0,
  detail: 0,
  createQuickLink: 0,
  removeQuickLink: 0,
};

const sessionProjectReader = {
  list: () => [
    {
      projectId: "project-1",
      projectKey: "alpha",
      status: "running",
      lastActivityAt: 321,
      dir: "/session/alpha",
    },
    {
      // Recorded against a project that has since been deleted or re-registered.
      projectId: "project-0",
      projectKey: "alpha",
      status: "completed",
      lastActivityAt: 900,
      dir: "/session/alpha-deleted",
    },
    {
      projectId: null,
      projectKey: "legacy-project",
      status: "completed",
      lastActivityAt: 150,
      dir: "/session/legacy",
    },
  ],
};

const projectService = fakeProjectService({
  list: () => {
    callLog.list += 1;
    return [
      {
        projectId: "project-1",
        key: "alpha",
        label: "Alpha Project",
        dir: "/project/alpha",
        quickLinks: [],
        lastSyncedAt: 1000,
      },
    ];
  },
  detail: (key) => {
    callLog.detail += 1;
    return {
      projectId: "project-1",
      key,
      label: "Alpha Project",
      dir: "/project/alpha",
      quickLinks: [],
      lastSyncedAt: 1000,
      documentation: { index: { title: "Index", content: "index" }, tree: [] },
    };
  },
  createQuickLink: (key, body) => {
    callLog.createQuickLink += 1;
    return {
      id: `${key}-quick-1`,
      title: String((body as { title?: string }).title ?? ""),
      url: String((body as { url?: string }).url ?? ""),
      order: 0,
    };
  },
  removeQuickLink: () => {
    callLog.removeQuickLink += 1;
    throw new ProjectServiceError(404, "UNKNOWN_QUICK_LINK", "unknown quick link");
  },
});

app.use("/api/v1", createAgentRouter({ projectService, sessionProjectReader }));

const api: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => api.once("listening", () => resolve()));
const apiAddress = api.address();
assert(apiAddress && typeof apiAddress === "object");
const base = `http://127.0.0.1:${apiAddress.port}/api/v1`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

test.after(async () => {
  api.closeAllConnections();
  await new Promise<void>((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
});

test("fleet project list route uses injected project and session services", async () => {
  callLog.list = 0;
  const response = await fetch(`${base}/projects`, { headers });
  assert.equal(response.status, 200);

  const payload = (await response.json()) as {
    projects: Array<{
      key: string;
      projectId: string | null;
      sessionCount: number;
      activeCount: number;
      lastActivityMs: number | null;
      path: string | null;
    }>;
  };

  const alpha = payload.projects.find((project) => project.key === "alpha");
  assert.equal(alpha?.projectId, "project-1");
  assert.equal(alpha?.path, "/project/alpha");
  assert.equal(alpha?.sessionCount, 1);
  assert.equal(alpha?.activeCount, 1);
  assert.equal(alpha?.lastActivityMs, 321);

  const legacy = payload.projects.find((project) => project.key === "legacy-project");
  assert.equal(legacy?.projectId, null);
  assert.equal(legacy?.path, "/session/legacy");
  assert.equal(legacy?.sessionCount, 1);
  assert.equal(legacy?.activeCount, 0);
  assert.equal(callLog.list, 1);

  // A session outlives the project it ran in, but its dead project ID must not
  // reappear here as a second, nameless row sharing a registered project's key.
  assert.deepEqual(payload.projects.map((project) => project.key), ["alpha", "legacy-project"]);
  assert.equal(payload.projects.some((project) => project.projectId === "project-0"), false);
});

test("fleet project detail route uses injected service", async () => {
  const response = await fetch(`${base}/projects/alpha`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()) as { projectId: string; key: string },
    {
      projectId: "project-1",
      key: "alpha",
      label: "Alpha Project",
      dir: "/project/alpha",
      quickLinks: [],
      lastSyncedAt: 1000,
      documentation: { index: { title: "Index", content: "index" }, tree: [] },
    },
  );
  assert.equal(callLog.detail, 1);
});

test("fleet project mutation route honors injected project service", async () => {
  const response = await fetch(`${base}/projects/alpha/quick-links`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Docs", url: "https://example.com/docs" }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { id: string; title: string; url: string; order: number }).id, "alpha-quick-1");
  assert.equal(callLog.createQuickLink, 1);
});

test("fleet project mutation error is converted through transport envelope", async () => {
  const response = await fetch(`${base}/projects/alpha/quick-links/missing`, {
    method: "DELETE",
    headers,
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json() as { code: string }).code, "UNKNOWN_QUICK_LINK");
  assert.equal(callLog.removeQuickLink, 1);
});
