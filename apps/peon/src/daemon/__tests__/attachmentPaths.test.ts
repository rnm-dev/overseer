import assert from "node:assert/strict";
import test from "node:test";
import { resolveAttachmentPath } from "../http/fleet/sessions.js";

const ROOT = "/tmp/peon-files";

test("an upload receipt's root-relative path resolves inside the root", () => {
  assert.equal(resolveAttachmentPath(ROOT, "uploads/session/plan.md"), "/tmp/peon-files/uploads/session/plan.md");
});

test("the absolute path a stored message carries is accepted as it stands", () => {
  // What a queued follow-up hands back when it is edited into the composer.
  assert.equal(
    resolveAttachmentPath(ROOT, "/tmp/peon-files/uploads/session/plan.md"),
    "/tmp/peon-files/uploads/session/plan.md",
  );
});

test("the root itself resolves", () => {
  assert.equal(resolveAttachmentPath(ROOT, "/tmp/peon-files"), "/tmp/peon-files");
});

test("neither form may leave the transfer root", () => {
  assert.equal(resolveAttachmentPath(ROOT, "/etc/shadow"), null);
  assert.equal(resolveAttachmentPath(ROOT, "../../etc/shadow"), null);
  assert.equal(resolveAttachmentPath(ROOT, "/tmp/peon-files/../../etc/shadow"), null);
  // A sibling directory whose name merely starts with the root's.
  assert.equal(resolveAttachmentPath(ROOT, "/tmp/peon-files-elsewhere/secret"), null);
});
