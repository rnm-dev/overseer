import assert from "node:assert/strict";
import { type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-management-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-management-state-"));

const { settings } = await import("../settings/index.js");
const { createAgentRouter } = await import("../agentApi.js");

const token = "pn_management_test";
settings.update({ overseerToken: token, paused: false });

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter());
const api: Server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => api.once("listening", resolve));
const apiAddress = api.address();
assert(apiAddress && typeof apiAddress === "object");
const base = `http://127.0.0.1:${apiAddress.port}/api/v1`;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

test.after(async () => {
  // Node's fetch keeps idle sockets alive; close them before waiting for the
  // listening servers so this test file cannot hold the full suite open.
  api.closeAllConnections();
  await new Promise<void>((resolve, reject) => api.close((err) => err ? reject(err) : resolve()));
});

test("fleet API changes peon paused status through status and settings", async () => {
  const paused = await fetch(`${base}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(paused.status, 200);
  assert.equal(((await paused.json()) as { paused: boolean }).paused, true);

  const resumed = await fetch(`${base}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ paused: false }),
  });
  assert.equal(resumed.status, 200);
  assert.equal(((await resumed.json()) as { paused: boolean }).paused, false);

  const invalid = await fetch(`${base}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ paused: "yes" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { code: string }).code, "BAD_REQUEST");
});

test("fleet API reads, updates, and clears the Peon soul", async () => {
  const soul = "## Working style\n\nBe candid and quietly persistent.";
  const updated = await fetch(`${base}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ soul }),
  });
  assert.equal(updated.status, 200);
  assert.equal(((await updated.json()) as { soul: string | null }).soul, soul);
  assert.equal(settings.get().ai.soul, soul);

  const read = await fetch(`${base}/settings`, { headers });
  assert.equal(((await read.json()) as { soul: string | null }).soul, soul);

  const cleared = await fetch(`${base}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ soul: "" }),
  });
  assert.equal(((await cleared.json()) as { soul: string | null }).soul, null);
  assert.equal(settings.get().ai.soul, "");

  const invalid = await fetch(`${base}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ soul: 42 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { code: string }).code, "BAD_REQUEST");
});

test("fleet API reads and edits a project's key, name, and folder through project settings", async () => {
  const label = "Folder Settings Project";
  const createdResponse = await fetch(`${base}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { projectId: string; key: string; dir: string };

  const settingsResponse = await fetch(`${base}/projects/${created.key}/settings`, { headers });
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual(await settingsResponse.json(), { projectId: created.projectId, key: created.key, name: label, dir: created.dir });
  const listResponse = await fetch(`${base}/projects`, { headers });
  const list = (await listResponse.json()) as { projects: Array<{ projectId: string; key: string }> };
  assert.equal(list.projects.find((project) => project.key === created.key)?.projectId, created.projectId);

  const newDir = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-project-parent-")), "new folder");
  const newKey = "renamed-folder-settings-project";
  const newName = "Renamed Folder Settings Project";
  const updatedResponse = await fetch(`${base}/projects/${created.key}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ key: newKey, name: newName, dir: newDir }),
  });
  assert.equal(updatedResponse.status, 200);
  assert.deepEqual(await updatedResponse.json(), { projectId: created.projectId, key: newKey, name: newName, dir: newDir });
  assert.equal(existsSync(newDir), true);

  const oldDetailResponse = await fetch(`${base}/projects/${created.key}`, { headers });
  assert.equal(oldDetailResponse.status, 404);
  const detailResponse = await fetch(`${base}/projects/${newKey}`, { headers });
  const detail = (await detailResponse.json()) as { projectId: string; key: string; label: string; dir: string };
  assert.equal(detail.projectId, created.projectId);
  assert.deepEqual({ key: detail.key, label: detail.label, dir: detail.dir }, { key: newKey, label: newName, dir: newDir });

  const invalidResponse = await fetch(`${base}/projects/${newKey}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ dir: "relative/path" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(((await invalidResponse.json()) as { code: string }).code, "BAD_REQUEST");

  const invalidKeyResponse = await fetch(`${base}/projects/${newKey}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ key: "Invalid Key" }),
  });
  assert.equal(invalidKeyResponse.status, 400);
  assert.equal(((await invalidKeyResponse.json()) as { code: string }).code, "BAD_REQUEST");

  const collisionProjectResponse = await fetch(`${base}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Settings Collision Project" }),
  });
  assert.equal(collisionProjectResponse.status, 201);
  const collisionResponse = await fetch(`${base}/projects/${newKey}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ key: "settings-collision-project" }),
  });
  assert.equal(collisionResponse.status, 409);
  assert.equal(((await collisionResponse.json()) as { code: string }).code, "PROJECT_EXISTS");
});

test("fleet API provides authorized project quick-link CRUD with stable errors", async () => {
  const createdResponse = await fetch(`${base}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Fleet Quick Links" }),
  });
  const project = (await createdResponse.json()) as { key: string };
  const createResponse = await fetch(`${base}/projects/${project.key}/quick-links`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Docs", url: "https://example.com/docs" }),
  });
  assert.equal(createResponse.status, 201);
  const link = (await createResponse.json()) as { id: string; order: number };
  assert.equal(link.order, 0);

  const unauthenticated = await fetch(`${base}/projects/${project.key}/quick-links`);
  assert.equal(unauthenticated.status, 401);
  const unsafe = await fetch(`${base}/projects/${project.key}/quick-links/${link.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ url: "javascript:alert(1)" }),
  });
  assert.equal(unsafe.status, 400);
  assert.equal(((await unsafe.json()) as { code: string }).code, "BAD_REQUEST");

  const updated = await fetch(`${base}/projects/${project.key}/quick-links/${link.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ title: "Documentation" }),
  });
  assert.equal(((await updated.json()) as { title: string }).title, "Documentation");
  const listed = await fetch(`${base}/projects/${project.key}/quick-links`, { headers });
  assert.equal(((await listed.json()) as { links: Array<{ id: string }> }).links[0]?.id, link.id);

  const removed = await fetch(`${base}/projects/${project.key}/quick-links/${link.id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  const missing = await fetch(`${base}/projects/${project.key}/quick-links/${link.id}`, { method: "DELETE", headers });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { code: string }).code, "UNKNOWN_QUICK_LINK");
});

test("fleet project info exposes the docs index, recursive tree, and individual pages", async () => {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "peon-project-docs-api-"));
  const createdResponse = await fetch(`${base}/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Docs API Project", dir: projectDir }),
  });
  const created = (await createdResponse.json()) as { key: string };
  const guideDir = path.join(projectDir, "docs", "guides");
  mkdirSync(guideDir, { recursive: true });
  writeFileSync(path.join(projectDir, "docs", "index.md"), "# Docs home\n\nStart here.\n");
  writeFileSync(path.join(guideDir, "setup.md"), "# Setup\n\nRun the service.\n");
  writeFileSync(path.join(guideDir, "ignored.json"), "{}\n");

  const detailResponse = await fetch(`${base}/projects/${created.key}`, { headers });
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as {
    documentation: { index: { title: string; content: string }; tree: Array<{ type: string; children?: Array<{ path: string }> }> };
  };
  assert.equal(detail.documentation.index.title, "Docs home");
  assert.equal(detail.documentation.index.content, "# Docs home\n\nStart here.\n");
  assert.deepEqual(detail.documentation.tree.find((node) => node.type === "directory")?.children?.map((node) => node.path), ["guides/setup.md"]);

  const pageResponse = await fetch(`${base}/projects/${created.key}/docs/guides/setup.md`, { headers });
  assert.equal(pageResponse.status, 200);
  assert.equal(((await pageResponse.json()) as { title: string }).title, "Setup");

  const unsupported = await fetch(`${base}/projects/${created.key}/docs/guides/ignored.json`, { headers });
  assert.equal(unsupported.status, 415);
  assert.equal(((await unsupported.json()) as { code: string }).code, "UNSUPPORTED_MEDIA_TYPE");
});
