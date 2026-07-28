import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../api";
import { en } from "../../locales/en";
import { ru } from "../../locales/ru";
import { createPeonFolderSource, folderErrorKey, listNearestPeonFolder, parentPath, type PeonFolderListing } from "./peonFolders";

test("browsing asks the folder-listing route, never the file-transfer proxy", async () => {
  const requested: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ path: "/", entries: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  try {
    const source = createPeonFolderSource("/workspaces/ws/peons/nova");
    await source.list("/home/peon/My Projects");
    await source.resolve("/");
  } finally {
    globalThis.fetch = original;
  }

  assert.deepEqual(requested, [
    "/api/workspaces/ws/peons/nova/folders?path=%2Fhome%2Fpeon%2FMy%20Projects",
    "/api/workspaces/ws/peons/nova/folders?path=%2F",
  ]);
  assert.equal(requested.some((url) => url.includes("/files") || url.includes("stat=1")), false);
});

test("the picker walks up to the nearest existing directory when it opens", async () => {
  assert.equal(parentPath("/home/peon/Projects/new-app"), "/home/peon/Projects");
  assert.equal(parentPath("/home"), "/");
  assert.equal(parentPath("/"), null);

  const asked: string[] = [];
  const request = async (path: string): Promise<PeonFolderListing> => {
    asked.push(path);
    if (path !== "/home/peon") throw new ApiError(404, "NOT_FOUND", "no such directory");
    return { path, entries: [{ name: "Projects", type: "directory" }] };
  };

  const listing = await listNearestPeonFolder("/base", "/home/peon/Projects/not-created-yet", undefined, request);
  assert.deepEqual(listing, { path: "/home/peon", entries: [{ name: "Projects", type: "directory" }] });
  assert.deepEqual(asked, ["/home/peon/Projects/not-created-yet", "/home/peon/Projects", "/home/peon"]);
});

test("only missing-directory failures fall back — everything else stays visible", async () => {
  const denied = async (): Promise<PeonFolderListing> => { throw new ApiError(403, "FORBIDDEN", "denied"); };
  await assert.rejects(
    listNearestPeonFolder("/base", "/root/secret", undefined, denied),
    (error: unknown) => error instanceof ApiError && error.code === "FORBIDDEN",
  );

  const offline = async (): Promise<PeonFolderListing> => { throw new ApiError(503, "PEON_OFFLINE", "offline"); };
  await assert.rejects(
    listNearestPeonFolder("/base", "/home/peon", undefined, offline),
    (error: unknown) => error instanceof ApiError && error.code === "PEON_OFFLINE",
  );
});

test("every folder-listing failure maps to a stable operator message", () => {
  assert.equal(folderErrorKey(new ApiError(409, "UNSUPPORTED_CAPABILITY", "x")), "pathSelector.unsupported");
  assert.equal(folderErrorKey(new ApiError(503, "PEON_OFFLINE", "x")), "pathSelector.offline");
  assert.equal(folderErrorKey(new ApiError(502, "CONNECTION_LOST", "x")), "pathSelector.offline");
  assert.equal(folderErrorKey(new ApiError(504, "TIMEOUT", "x")), "pathSelector.timeout");
  assert.equal(folderErrorKey(new ApiError(403, "FORBIDDEN", "x")), "pathSelector.forbidden");
  assert.equal(folderErrorKey(new ApiError(404, "NOT_FOUND", "x")), "pathSelector.missing");
  assert.equal(folderErrorKey(new ApiError(400, "NOT_DIRECTORY", "x")), "pathSelector.notDirectory");
  assert.equal(folderErrorKey(new ApiError(400, "INVALID_PATH", "x")), "pathSelector.invalidPath");
  assert.equal(folderErrorKey(new ApiError(409, "SYNC_IN_PROGRESS", "x")), "pathSelector.busy");
  assert.equal(folderErrorKey(new ApiError(502, "LISTING_TOO_LARGE", "x")), "pathSelector.tooLarge");
  assert.equal(folderErrorKey(new ApiError(500, "INTERNAL", "x")), "error.loadFailed");
  assert.equal(folderErrorKey(new Error("boom")), "error.loadFailed");

  const keys = [
    "pathSelector.unsupported", "pathSelector.offline", "pathSelector.timeout", "pathSelector.forbidden",
    "pathSelector.missing", "pathSelector.notDirectory", "pathSelector.invalidPath", "pathSelector.busy",
    "pathSelector.tooLarge", "error.loadFailed",
  ];
  for (const key of keys) {
    assert.ok(en[key], `missing English string for ${key}`);
    assert.ok(ru[key], `missing Russian string for ${key}`);
  }
});
