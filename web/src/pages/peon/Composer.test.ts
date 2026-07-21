import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import { Composer, isFileDrag } from "./Composer";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("composer exposes the shared file drop zone", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Send",
      disabled: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  assert.match(markup, /data-file-drop-zone="composer"/);
  assert.match(markup, /type="file"/);
});

test("file drag detection ignores ordinary text and link drags", () => {
  assert.equal(isFileDrag(["Files"]), true);
  assert.equal(isFileDrag(["text/plain", "text/uri-list"]), false);
});

test("an unavailable composer is disabled without showing an in-flight spinner", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "queued draft",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Send",
      disabled: true,
      pending: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  assert.match(markup, /disabled=""/);
  assert.doesNotMatch(markup, /animate-spin/);
});
