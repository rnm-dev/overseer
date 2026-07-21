import assert from "node:assert/strict";
import test from "node:test";
import {
  documentationBreadcrumbs,
  documentationFilePath,
  documentationListingPath,
  documentationPresentation,
  resolveDocumentationLink,
  retryDocumentationRequest,
} from "./ProjectDocumentation";
import { ApiError } from "../../api";

test("documentation presentation prefers an exact docs/index.md file", () => {
  assert.deepEqual(documentationPresentation({
    exists: true,
    entries: [
      { name: "guide.md", type: "file" },
      { name: "index.md", type: "file" },
      { name: "assets", type: "directory" },
    ],
  }), { kind: "index", entry: { name: "index.md", type: "file" } });
});

test("documentation presentation distinguishes a missing folder from a directory listing", () => {
  assert.deepEqual(documentationPresentation({ exists: false, entries: [] }), { kind: "missing" });
  assert.deepEqual(documentationPresentation({
    exists: true,
    entries: [{ name: "Index.md", type: "file" }, { name: "api", type: "directory" }],
  }), {
    kind: "listing",
    entries: [{ name: "Index.md", type: "file" }, { name: "api", type: "directory" }],
  });
});

test("documentation endpoints encode the stable project ID", () => {
  assert.equal(documentationListingPath("/workspaces/ws/peons/nova", "project/id"), "/workspaces/ws/peons/nova/projects/project%2Fid/docs");
  assert.equal(documentationFilePath("/workspaces/ws/peons/nova", "project/id", "docs/getting started.md"), "/workspaces/ws/peons/nova/projects/by-id/project%2Fid/files/docs/getting%20started.md");
});

test("relative Markdown links stay inside the project and preserve normal path semantics", () => {
  assert.equal(resolveDocumentationLink("docs/index.md", "../PROTOCOL.md"), "PROTOCOL.md");
  assert.equal(resolveDocumentationLink("docs/index.md", "guides/setup.md#install"), "docs/guides/setup.md");
  assert.equal(resolveDocumentationLink("docs/guides/setup.md", "../api.md"), "docs/api.md");
  assert.equal(resolveDocumentationLink("docs/index.md", "../../secret.md"), null);
  assert.equal(resolveDocumentationLink("docs/index.md", "..%5Csecret.md"), null);
  assert.equal(resolveDocumentationLink("docs/index.md", "https://example.com/readme.md"), null);
  assert.equal(resolveDocumentationLink("docs/index.md", "../logo.png"), null);
});

test("documentation breadcrumbs default to Project > docs and expose an opened file path", () => {
  assert.deepEqual(documentationBreadcrumbs(), ["docs"]);
  assert.deepEqual(documentationBreadcrumbs("docs/index.md"), ["docs"]);
  assert.deepEqual(documentationBreadcrumbs("PROTOCOL.md"), ["PROTOCOL.md"]);
  assert.deepEqual(documentationBreadcrumbs("docs/guides/setup.md"), ["docs", "guides", "setup.md"]);
});

test("documentation requests retry transient failures but preserve authoritative errors", async () => {
  const controller = new AbortController();
  let calls = 0;
  assert.equal(await retryDocumentationRequest(async () => {
    calls += 1;
    if (calls < 3) throw new ApiError(409, "SYNC_IN_PROGRESS", "busy");
    return "ready";
  }, controller.signal, [0, 0]), "ready");
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(retryDocumentationRequest(async () => {
    calls += 1;
    throw new ApiError(404, "NOT_FOUND", "gone");
  }, controller.signal, [0, 0]), (error: unknown) => error instanceof ApiError && error.code === "NOT_FOUND");
  assert.equal(calls, 1);
});
