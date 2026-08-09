import assert from "node:assert/strict";
import test from "node:test";
import {
  initialLivePreviewState,
  LIVE_PREVIEW_LIMITS,
  reduceLivePreview,
  type LivePreviewAsset,
} from "./livePreviewState.js";

const hash = "a".repeat(64);
const html: LivePreviewAsset = {
  path: "index.html",
  size: 12,
  sha256: hash,
  contentType: "text/html; charset=utf-8",
};

test("preview lifecycle activates only the complete in-flight revision", () => {
  const pending = initialLivePreviewState();
  const uploading = reduceLivePreview(pending, { type: "begin", revision: 1 });
  assert.equal(uploading.status, "uploading");

  const ignored = reduceLivePreview(uploading, {
    type: "activate",
    revision: 2,
    entryPath: "index.html",
    assets: [html],
  });
  assert.equal(ignored, uploading);

  const ready = reduceLivePreview(uploading, {
    type: "activate",
    revision: 1,
    entryPath: "index.html",
    assets: [html],
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.activeRevision, 1);
  assert.equal(ready.active?.totalBytes, 12);
});

test("newer ingest fences stale completion and failure", () => {
  let state = reduceLivePreview(initialLivePreviewState(), { type: "begin", revision: 1 });
  state = reduceLivePreview(state, { type: "begin", revision: 2 });
  const staleComplete = reduceLivePreview(state, {
    type: "activate",
    revision: 1,
    entryPath: "index.html",
    assets: [html],
  });
  assert.equal(staleComplete, state);
  assert.equal(reduceLivePreview(state, { type: "fail", revision: 1, code: "CHECKSUM" }), state);
});

test("a failed revision still fences replay and older revisions", () => {
  let state = reduceLivePreview(initialLivePreviewState(), { type: "begin", revision: 4 });
  state = reduceLivePreview(state, { type: "fail", revision: 4, code: "CHECKSUM" });
  assert.equal(state.status, "error");
  assert.equal(state.observedRevision, 4);
  assert.equal(reduceLivePreview(state, { type: "begin", revision: 4 }), state);
  assert.equal(reduceLivePreview(state, { type: "begin", revision: 3 }), state);
});

test("manifest validation is bounded and rejects unsafe paths and active types", () => {
  const uploading = reduceLivePreview(initialLivePreviewState(), { type: "begin", revision: 1 });
  assert.throws(() => reduceLivePreview(uploading, {
    type: "activate",
    revision: 1,
    entryPath: "../index.html",
    assets: [html],
  }), /invalid preview manifest/);
  assert.throws(() => reduceLivePreview(uploading, {
    type: "activate",
    revision: 1,
    entryPath: "index.html",
    assets: [{ ...html, contentType: "text/html" }],
  }), /invalid preview asset/);
  assert.throws(() => reduceLivePreview(uploading, {
    type: "activate",
    revision: 1,
    entryPath: "index.html",
    assets: [{ ...html, size: LIVE_PREVIEW_LIMITS.maxAssetBytes + 1 }],
  }), /invalid preview asset/);
});

test("delete is monotonic and expiry is terminal", () => {
  let state = reduceLivePreview(initialLivePreviewState(), { type: "delete", revision: 3 });
  assert.equal(state.status, "deleted");
  assert.equal(state.activeRevision, 3);
  assert.equal(reduceLivePreview(state, { type: "begin", revision: 2 }), state);

  state = reduceLivePreview(state, { type: "expire" });
  assert.equal(state.status, "expired");
  assert.equal(reduceLivePreview(state, { type: "begin", revision: 4 }), state);
});
