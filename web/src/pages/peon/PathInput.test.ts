import assert from "node:assert/strict";
import test from "node:test";
import { isPathWithin, normalizeAbsolutePath, pathFromRoot, relativeToRoot, virtualDirectoryNames } from "./PathInput";

test("path selector normalizes and joins absolute paths", () => {
  assert.equal(normalizeAbsolutePath("/srv//projects/../repos/"), "/srv/repos");
  assert.equal(pathFromRoot("/", "home/peon"), "/home/peon");
  assert.equal(pathFromRoot("/srv/files/", "projects/app"), "/srv/files/projects/app");
});

test("relative API paths are derived only for values inside a browse root", () => {
  assert.equal(relativeToRoot("/srv/files/projects/app", "/srv/files"), "projects/app");
  assert.equal(relativeToRoot("/srv/files", "/srv/files"), "");
  assert.equal(relativeToRoot("/home/peon", "/srv/files"), "");
});

test("breadcrumb ancestors expose known project folders until a real browse root is reached", () => {
  const locations = [
    { root: "/rnm/overseer", base: "/projects/overseer/files" },
    { root: "/rnm/heroboard", base: "/projects/heroboard/files" },
    { root: "/kundelik/app", base: "/projects/app/files" },
  ];
  assert.deepEqual(virtualDirectoryNames("/", locations), ["kundelik", "rnm"]);
  assert.deepEqual(virtualDirectoryNames("/rnm", locations), ["heroboard", "overseer"]);
  assert.equal(isPathWithin("/rnm/overseer/web", "/rnm/overseer"), true);
  assert.equal(isPathWithin("/rnm/heroboard", "/rnm/overseer"), false);
});
