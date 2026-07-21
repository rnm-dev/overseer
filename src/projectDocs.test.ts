import assert from "node:assert/strict";
import test from "node:test";
import { childPath, listProjectDocs } from "./projectDocs.js";
import { PeonOperationError } from "./peonOperationChannel.js";
import type { FolderListInput, FolderListResult } from "./peonFolderListing.js";
import { peonsRouter } from "./routes/peons.js";

test("project docs listing resolves docs from an immutable project root", async () => {
  const calls: FolderListInput[] = [];
  const request = async (_peonId: string, input: FolderListInput): Promise<FolderListResult> => {
    calls.push(input);
    if (input.projectId) {
      return {
        path: "/work/demo",
        projectId: input.projectId,
        entries: [{ name: "src", type: "directory" }, { name: "docs", type: "directory" }],
      };
    }
    return {
      path: "/work/demo/docs",
      projectId: null,
      entries: [{ name: "index.md", type: "file" }, { name: "guide.md", type: "file" }],
    };
  };

  assert.deepEqual(await listProjectDocs("peon", "stable-project", undefined, request), {
    exists: true,
    entries: [{ name: "index.md", type: "file" }, { name: "guide.md", type: "file" }],
  });
  assert.deepEqual(calls, [{ projectId: "stable-project" }, { path: "/work/demo/docs" }]);
});

test("project docs listing returns an empty contract when docs is absent or removed", async () => {
  const absent = async (): Promise<FolderListResult> => ({
    path: "/work/demo", projectId: "stable-project", entries: [{ name: "docs", type: "file" }],
  });
  assert.deepEqual(await listProjectDocs("peon", "stable-project", undefined, absent), { exists: false, entries: [] });

  let call = 0;
  const removed = async (): Promise<FolderListResult> => {
    call += 1;
    if (call === 1) return { path: "/work/demo", projectId: "stable-project", entries: [{ name: "docs", type: "directory" }] };
    throw new PeonOperationError("NOT_FOUND", "gone", 404);
  };
  assert.deepEqual(await listProjectDocs("peon", "stable-project", undefined, removed), { exists: false, entries: [] });
});

test("project docs listing preserves actionable failures and joins Windows roots", async () => {
  assert.equal(childPath("C:\\work\\demo\\", "docs"), "C:\\work\\demo\\docs");
  assert.equal(childPath("/", "docs"), "/docs");
  await assert.rejects(
    listProjectDocs("peon", "project", undefined, async () => { throw new PeonOperationError("PEON_OFFLINE", "offline", 503); }),
    (error: unknown) => error instanceof PeonOperationError && error.code === "PEON_OFFLINE" && error.status === 503,
  );
});

test("project docs route uses the concise stable-ID URL", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/projects/:projectId/docs");
  assert.equal(route?.route?.methods?.get, true);
  assert.equal(router.stack.some((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/projects/by-id/:projectId/docs"), false);
});

test("project docs listing retries transient channel contention with bounded backoff", async () => {
  let calls = 0;
  const waits: number[] = [];
  const request = async (_peonId: string, input: FolderListInput): Promise<FolderListResult> => {
    calls += 1;
    if (calls <= 2) throw new PeonOperationError("SYNC_IN_PROGRESS", "busy", 409);
    return { path: "/work/demo", projectId: input.projectId ?? null, entries: [] };
  };
  assert.deepEqual(await listProjectDocs("peon", "project", undefined, request, {
    attempts: 3,
    random: () => 0.5,
    pause: async (ms) => { waits.push(ms); },
  }), { exists: false, entries: [] });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [50, 100]);
});

test("project docs listing does not retry authoritative errors", async () => {
  let calls = 0;
  await assert.rejects(listProjectDocs("peon", "project", undefined, async () => {
    calls += 1;
    throw new PeonOperationError("FORBIDDEN", "no", 403);
  }, { attempts: 7, pause: async () => assert.fail("must not wait") }),
  (error: unknown) => error instanceof PeonOperationError && error.code === "FORBIDDEN");
  assert.equal(calls, 1);
});
