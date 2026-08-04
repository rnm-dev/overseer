import assert from "node:assert/strict";
import test from "node:test";
import { projectDocsFromSnapshot } from "./modules/projects/index.js";
import { parseProjectDocumentationSnapshot } from "./modules/reverseCommands/reverseCommandTypes.js";
import { peonsRouter } from "./routes/peons.js";

test("project docs route uses the concise stable-ID URL", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/projects/:projectId/docs");
  assert.equal(route?.route?.methods?.get, true);
  assert.equal(router.stack.some((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/projects/by-id/:projectId/docs"), false);
});

test("reverse documentation snapshots normalize to the same listing contract as HTTP", () => {
  const snapshot = parseProjectDocumentationSnapshot(JSON.stringify({
    exists: true,
    indexPath: "index.md",
    index: {
      path: "index.md", name: "index.md", title: "Demo", content: "# Demo",
      size: 100, mtimeMs: 3, truncated: false,
    },
    tree: [
      { type: "directory", name: "guides", path: "guides", children: [
        { type: "file", name: "deploy.md", path: "guides/deploy.md", size: 300, mtimeMs: 5 },
      ] },
      { type: "file", name: "index.md", path: "index.md", size: 100, mtimeMs: 3 },
      { type: "file", name: "guide.md", path: "guide.md", size: 200, mtimeMs: 4 },
    ],
  }));

  assert.deepEqual(projectDocsFromSnapshot(snapshot), {
    exists: true,
    entries: [
      { name: "guides", type: "directory", size: null, mtimeMs: null },
      { name: "index.md", type: "file", size: 100, mtimeMs: 3 },
      { name: "guide.md", type: "file", size: 200, mtimeMs: 4 },
    ],
  });
});

test("a project without documentation normalizes to the empty listing", () => {
  const snapshot = parseProjectDocumentationSnapshot(JSON.stringify({
    exists: false, indexPath: "index.md", index: null, tree: [],
  }));
  assert.deepEqual(projectDocsFromSnapshot(snapshot), { exists: false, entries: [] });
});
