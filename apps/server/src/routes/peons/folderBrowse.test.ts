import assert from "node:assert/strict";
import test from "node:test";
import { FolderBrowseError, folderBrowseSelector } from "../../modules/projects/index.js";
import { peonsRouter } from "../peons.js";

test("folder browse selector defaults to the filesystem root and validates the public bound", () => {
  assert.deepEqual(folderBrowseSelector(undefined, undefined), { path: "/" });
  assert.deepEqual(folderBrowseSelector("  ", undefined), { path: "/" });
  assert.deepEqual(folderBrowseSelector("/home/peon", "200"), { path: "/home/peon", limit: 200 });
  assert.deepEqual(folderBrowseSelector("C:\\work", ""), { path: "C:\\work" });

  for (const limit of ["0", "-1", "2.5", "501", "many"]) {
    assert.throws(() => folderBrowseSelector("/", limit), (error: unknown) =>
      error instanceof FolderBrowseError && error.code === "BAD_REQUEST" && error.status === 400);
  }
  assert.throws(() => folderBrowseSelector(["/", "/etc"], undefined), (error: unknown) =>
    error instanceof FolderBrowseError && error.code === "BAD_REQUEST");
  assert.throws(() => folderBrowseSelector("relative/path", undefined), (error: unknown) =>
    error instanceof FolderBrowseError && error.code === "BAD_REQUEST");
});

test("the new-project directory picker keeps its authenticated peon-scoped route", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/folders");
  assert.equal(route?.route?.methods?.get, true);
});
