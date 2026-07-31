import assert from "node:assert/strict";
import test from "node:test";
import {
  FileSandboxError,
  absolutePathOf,
  isAbsoluteRequest,
  resolveAttachmentPath,
  resolveSandboxSegments,
  sandboxSegmentsOf,
} from "./peonFileSandbox.js";
import { PATH_ESCAPE_PUBLIC_MESSAGE } from "./fileErrorSafety.js";
import { peonsRouter } from "./routes/peons.js";

const conn = { baseUrl: "https://peon.example.test", token: "t" };
const rootIs = (root: string) => async () => root;

test("an absolute request is the one a joined-on path produces", () => {
  assert.equal(isAbsoluteRequest(["", "tmp", "peon-files"]), true);
  assert.equal(isAbsoluteRequest(["uploads", "s", "a.png"]), false);
  assert.equal(isAbsoluteRequest([]), false);
  assert.equal(absolutePathOf(["", "tmp", "peon-files", "a b.png"]), "/tmp/peon-files/a b.png");
});

test("an absolute path maps into the sandbox only while it stays under the root", () => {
  assert.deepEqual(sandboxSegmentsOf("/tmp/peon-files", "/tmp/peon-files/uploads/s/a.png"), ["uploads", "s", "a.png"]);
  assert.deepEqual(sandboxSegmentsOf("/tmp/peon-files/", "/tmp/peon-files/uploads/s/a.png"), ["uploads", "s", "a.png"]);
  assert.deepEqual(sandboxSegmentsOf("/tmp/peon-files", "/tmp/peon-files"), []);
  // A dashboard-uploaded attachment lives outside the transfer root entirely.
  assert.equal(sandboxSegmentsOf("/tmp/peon-files", "/home/peon/.peon/sessions/s/attachments/a.png"), null);
  // Prefix similarity is not containment.
  assert.equal(sandboxSegmentsOf("/tmp/peon-files", "/tmp/peon-files-other/a.png"), null);
  assert.equal(sandboxSegmentsOf("/tmp/peon-files", "/tmp/peon-files/../etc/shadow"), null);
  assert.equal(sandboxSegmentsOf("/", "/tmp/a.png"), null);
});

test("the file route resolves an absolute path and leaves a relative one alone", async () => {
  assert.deepEqual(
    await resolveSandboxSegments(conn, ["", "tmp", "peon-files", "uploads", "s", "a.png"], "u@example.com", rootIs("/tmp/peon-files")),
    ["uploads", "s", "a.png"],
  );
  assert.deepEqual(
    await resolveSandboxSegments(conn, ["uploads", "s", "a.png"], "u@example.com", async () => {
      throw new Error("a relative request must not cost a settings call");
    }),
    ["uploads", "s", "a.png"],
  );
});

test("the attachment surface accepts both path forms a transcript can carry", async () => {
  assert.deepEqual(
    await resolveAttachmentPath(conn, "/tmp/peon-files/uploads/s/pasted-1-0.png", null, rootIs("/tmp/peon-files")),
    ["uploads", "s", "pasted-1-0.png"],
  );
  assert.deepEqual(await resolveAttachmentPath(conn, "uploads/s/a.png", null, rootIs("/tmp/peon-files")), ["uploads", "s", "a.png"]);
});

test("a refused attachment read is actionable without disclosing its root or rejected path", async () => {
  const sentinelRoot = "/srv/__OVSR249_ROOT_SENTINEL__/transfer";
  const sentinelPath = "/srv/__OVSR249_REJECTED_PATH_SENTINEL__/secret";
  const outside = await resolveAttachmentPath(conn, sentinelPath, null, rootIs(sentinelRoot)).catch((err: unknown) => err);
  assert.ok(outside instanceof FileSandboxError && outside.status === 400 && outside.code === "PATH_ESCAPE");
  assert.equal((outside as FileSandboxError).message, PATH_ESCAPE_PUBLIC_MESSAGE);
  assert.doesNotMatch((outside as FileSandboxError).message, new RegExp(sentinelRoot));
  assert.doesNotMatch((outside as FileSandboxError).message, new RegExp(sentinelPath));

  for (const bad of [undefined, "", "   ", 42, ["/a", "/b"]]) {
    const error = await resolveAttachmentPath(conn, bad, null, rootIs("/tmp/peon-files")).catch((err: unknown) => err);
    assert.ok(error instanceof FileSandboxError && error.status === 400 && error.code === "BAD_REQUEST");
  }

  const traversal = await resolveAttachmentPath(conn, "uploads/../../etc/shadow", null, rootIs("/tmp/peon-files")).catch((err: unknown) => err);
  assert.ok(traversal instanceof FileSandboxError && traversal.code === "PATH_ESCAPE");

  const disabled = await resolveAttachmentPath(conn, "/tmp/a.png", null, async () => {
    throw new FileSandboxError(503, "FILES_DISABLED", "file transfer is disabled on this Peon");
  }).catch((err: unknown) => err);
  assert.ok(disabled instanceof FileSandboxError && disabled.status === 503 && disabled.code === "FILES_DISABLED");
});

test("the attachment read route is registered on the peon router", () => {
  const router = peonsRouter() as unknown as { stack: { route?: { path?: string; methods?: Record<string, boolean> } }[] };
  const route = router.stack.find((layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/attachments");
  assert.equal(route?.route?.methods?.get, true);
});
