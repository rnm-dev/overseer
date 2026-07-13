import assert from "node:assert/strict";
import test from "node:test";
import { attachmentPreviewKind } from "./attachmentPreviewKind";

test("recognizes image attachments served as generic binary data", () => {
  assert.equal(attachmentPreviewKind({}, "application/octet-stream", "pasted-123-0.png"), "image");
  assert.equal(attachmentPreviewKind({}, "application/octet-stream", "PHOTO.JPEG"), "image");
});

test("prefers attachment and response metadata when an extension is unavailable", () => {
  assert.equal(attachmentPreviewKind({ type: "image" }, "application/octet-stream", "upload"), "image");
  assert.equal(attachmentPreviewKind({}, "image/webp", "upload"), "image");
  assert.equal(attachmentPreviewKind({}, "application/pdf; charset=binary", "upload"), "pdf");
});

test("keeps text and unknown binary attachments distinct", () => {
  assert.equal(attachmentPreviewKind({}, "application/octet-stream", "notes.md"), "text");
  assert.equal(attachmentPreviewKind({}, "application/octet-stream", "archive.zip"), "unsupported");
});
