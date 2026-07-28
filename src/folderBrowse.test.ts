import assert from "node:assert/strict";
import test from "node:test";
import { browsePeonFolders, folderBrowseSelector } from "./modules/projects/index.js";
import { PeonOperationError } from "./peonOperationChannel.js";
import type { FolderListInput, FolderListResult } from "./peonFolderListing.js";
import { peonsRouter } from "./routes/peons.js";

test("folder browse selector defaults to the filesystem root and bounds the page size", () => {
  assert.deepEqual(folderBrowseSelector(undefined, undefined), { path: "/" });
  assert.deepEqual(folderBrowseSelector("  ", undefined), { path: "/" });
  assert.deepEqual(folderBrowseSelector("/home/peon", "200"), { path: "/home/peon", limit: 200 });
  assert.deepEqual(folderBrowseSelector("C:\\work", ""), { path: "C:\\work" });

  for (const limit of ["0", "-1", "2.5", "many"]) {
    assert.throws(() => folderBrowseSelector("/", limit), (error: unknown) =>
      error instanceof PeonOperationError && error.code === "BAD_REQUEST" && error.status === 400);
  }
  assert.throws(() => folderBrowseSelector(["/", "/etc"], undefined), (error: unknown) =>
    error instanceof PeonOperationError && error.code === "BAD_REQUEST");
});

test("folder browse lists directories only, sorted, over the folder-listing operation", async () => {
  const calls: FolderListInput[] = [];
  const request = async (peonId: string, input: FolderListInput, signal?: AbortSignal): Promise<FolderListResult> => {
    assert.equal(peonId, "peon");
    assert.equal(signal?.aborted, false);
    calls.push(input);
    return {
      path: "/",
      projectId: null,
      entries: [
        { name: "srv", type: "directory" },
        { name: "swapfile", type: "file" },
        { name: "etc", type: "directory" },
      ],
    };
  };

  const controller = new AbortController();
  assert.deepEqual(await browsePeonFolders("peon", { path: "/" }, controller.signal, request), {
    path: "/",
    entries: [{ name: "etc", type: "directory" }, { name: "srv", type: "directory" }],
  });
  assert.deepEqual(calls, [{ path: "/" }]);
});

test("an overlapping listing waits for its turn instead of showing the operator a busy Peon", async () => {
  // The picker's own superseded request, the docs panel or a second operator can
  // hold the Peon's single folder-listing slot; the refusal is transient.
  let call = 0;
  const request = async (): Promise<FolderListResult> => {
    call += 1;
    if (call < 3) throw new PeonOperationError("SYNC_IN_PROGRESS", "another Peon operation is already in progress", 409);
    return { path: "/", projectId: null, entries: [{ name: "srv", type: "directory" }] };
  };
  const waits: number[] = [];
  const retry = { pause: async (ms: number) => { waits.push(ms); }, random: () => 0.5 };

  assert.deepEqual(await browsePeonFolders("peon", { path: "/" }, undefined, request, retry), {
    path: "/",
    entries: [{ name: "srv", type: "directory" }],
  });
  assert.deepEqual(waits, [50, 100]);

  // A Peon that stays busy still ends in a stated failure, not an endless wait.
  const busy = async (): Promise<FolderListResult> => { throw new PeonOperationError("SYNC_IN_PROGRESS", "busy", 409); };
  await assert.rejects(
    browsePeonFolders("peon", { path: "/" }, undefined, busy, { attempts: 3, pause: async () => {}, random: () => 0.5 }),
    (error: unknown) => error instanceof PeonOperationError && error.code === "SYNC_IN_PROGRESS",
  );
});

test("folder browse surfaces the Peon's own failures unchanged", async () => {
  const fail = (error: PeonOperationError) => async (): Promise<FolderListResult> => { throw error; };
  await assert.rejects(
    browsePeonFolders("peon", { path: "/root" }, undefined, fail(new PeonOperationError("FORBIDDEN", "denied", 403))),
    (error: unknown) => error instanceof PeonOperationError && error.code === "FORBIDDEN" && error.status === 403,
  );
  await assert.rejects(
    browsePeonFolders("peon", { path: "/" }, undefined, fail(new PeonOperationError("UNSUPPORTED_CAPABILITY", "no folder-listing-v1", 409))),
    (error: unknown) => error instanceof PeonOperationError && error.code === "UNSUPPORTED_CAPABILITY" && error.status === 409,
  );
});

test("the new-project directory picker has an authenticated peon-scoped route", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/folders");
  assert.equal(route?.route?.methods?.get, true);
});
