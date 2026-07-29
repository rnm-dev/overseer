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
import { peonsRouter } from "./routes/peons.js";

const conn = { baseUrl: "http://peon.mesh.rnm:4570", token: "t" };
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

test("a refused attachment read names why, so the operator is not left with a bare status", async () => {
  const outside = await resolveAttachmentPath(conn, "/etc/shadow", null, rootIs("/tmp/peon-files")).catch((err: unknown) => err);
  assert.ok(outside instanceof FileSandboxError && outside.status === 400 && outside.code === "PATH_ESCAPE");
  assert.match((outside as FileSandboxError).message, /\/tmp\/peon-files/);

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
