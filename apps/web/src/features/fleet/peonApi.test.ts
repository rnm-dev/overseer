import assert from "node:assert/strict";
import test from "node:test";
import {
  createProject,
  createProjectQuickLink,
  deleteProjectQuickLink,
  getProjectQuickLinks,
  getProjectSettings,
  getProjectSkills,
  getPeonSoul,
  savePeonSoul,
  soulExcerpt,
  projectMetadataValue,
  projectRoute,
  updateProjectSettings,
  updateProjectQuickLink,
  type ApiRequest,
} from "./peonApi";
import { ApiError } from "../../shared/api";

function recorder(response: unknown = {}): { calls: Array<{ path: string; options?: RequestInit }>; request: ApiRequest } {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  return {
    calls,
    request: async <T>(path: string, options?: RequestInit) => {
      calls.push({ path, options });
      return response as T;
    },
  };
}

test("loads a configured Peon soul from settings", async () => {
  const fake = recorder({ name: "worker", soul: "# Steadfast\n\nAlways verify." });
  assert.equal(await getPeonSoul("/peon", fake.request), "# Steadfast\n\nAlways verify.");
  assert.deepEqual(fake.calls, [{ path: "/peon/settings", options: undefined }]);
});

test("saves a soul with a partial settings patch", async () => {
  const fake = recorder({ name: "must not be sent", soul: "Be curious." });
  assert.equal(await savePeonSoul("/peon", "Be curious.", fake.request), "Be curious.");
  assert.deepEqual(JSON.parse(String(fake.calls[0].options?.body)), { soul: "Be curious." });
  assert.equal(fake.calls[0].options?.method, "PATCH");
});

test("clears a soul by sending an empty string and no unrelated settings", async () => {
  const fake = recorder({ soul: null });
  assert.equal(await savePeonSoul("/peon", "", fake.request), null);
  assert.deepEqual(JSON.parse(String(fake.calls[0].options?.body)), { soul: "" });
});

test("treats a settings response from an older Peon with no soul field as unconfigured", async () => {
  const fake = recorder({ name: "legacy", heartbeatIntervalMs: 5000 });
  assert.equal(await getPeonSoul("/peon", fake.request), null);
});

test("surfaces Peon's BAD_REQUEST response when saving a soul fails", async () => {
  const failure = new ApiError(400, "BAD_REQUEST", "soul is too long");
  const request: ApiRequest = async () => { throw failure; };
  await assert.rejects(() => savePeonSoul("/peon", "too much", request), (error: unknown) => {
    assert.equal(error, failure);
    assert.equal((error as ApiError).code, "BAD_REQUEST");
    assert.equal((error as Error).message, "soul is too long");
    return true;
  });
});

test("soul excerpts remove Markdown decoration and stay short", () => {
  assert.equal(soulExcerpt("# Builder\n\nUse **care** and [evidence](https://example.test)."), "Builder Use care and evidence.");
  assert.equal(soulExcerpt("abcdefgh", 5), "abcd…");
});

test("project creation and consolidated settings use the revised API", async () => {
  const fake = recorder({ key: "renamed", name: "Local", dir: "/work/local", metadata: null });
  await createProject("/peon", { label: "Local", dir: "/work/local", metadata: "# Local\n\nNotes" }, fake.request);
  assert.equal((await getProjectSettings("/peon", "local/project", fake.request)).key, "renamed");
  const renamed = await updateProjectSettings("/peon", "local/project", { key: "renamed", name: "Local", dir: "/work/local", metadata: null }, fake.request);

  assert.deepEqual(fake.calls.map(({ path, options }) => [path, options?.method, options?.body ? JSON.parse(String(options.body)) : undefined]), [
    ["/peon/projects", "POST", { label: "Local", dir: "/work/local", metadata: "# Local\n\nNotes" }],
    ["/peon/projects/local%2Fproject/settings", undefined, undefined],
    ["/peon/projects/local%2Fproject/settings", "PATCH", { key: "renamed", name: "Local", dir: "/work/local", metadata: null }],
  ]);
  assert.equal(renamed.key, "renamed");
  assert.equal(renamed.metadata, null);
});

test("project skills use the encoded workspace-scoped project endpoint", async () => {
  const fake = recorder({ skills: [{ name: "release", description: "Ships a release." }] });
  const result = await getProjectSkills("/workspaces/ws/peons/peon", "local/project", fake.request);

  assert.deepEqual(result.skills, [{ name: "release", description: "Ships a release." }]);
  assert.deepEqual(fake.calls, [{
    path: "/workspaces/ws/peons/peon/projects/local%2Fproject/skills",
    options: { cache: "no-store" },
  }]);
});

test("project quick-link API encodes project and link identities for CRUD", async () => {
  const fake = recorder({ links: [] });
  await getProjectQuickLinks("/peon", "local/project", fake.request);
  await createProjectQuickLink("/peon", "local/project", { title: "Docs", url: "https://example.test/docs" }, fake.request);
  await updateProjectQuickLink("/peon", "local/project", "link/id", { title: "Runbook", url: "https://example.test/runbook" }, fake.request);
  await deleteProjectQuickLink("/peon", "local/project", "link/id", fake.request);

  assert.deepEqual(fake.calls.map(({ path, options }) => [path, options?.method]), [
    ["/peon/projects/local%2Fproject/quick-links", undefined],
    ["/peon/projects/local%2Fproject/quick-links", "POST"],
    ["/peon/projects/local%2Fproject/quick-links/link%2Fid", "PATCH"],
    ["/peon/projects/local%2Fproject/quick-links/link%2Fid", "DELETE"],
  ]);
});

test("only an empty metadata value is normalized to null", () => {
  assert.equal(projectMetadataValue(""), null);
  assert.equal(projectMetadataValue("# Heading"), "# Heading");
  assert.equal(projectMetadataValue("  "), "  ");
});

test("a returned renamed project key becomes the encoded active route", () => {
  assert.equal(projectRoute("peon/one", "renamed/project"), "/peons/peon%2Fone/projects/renamed%2Fproject");
});
