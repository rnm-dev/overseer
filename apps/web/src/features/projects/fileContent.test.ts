import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../shared/i18n";
import { FileView, keepsShownContent } from "./FileView";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("re-reading the file on screen keeps it, rather than flashing a spinner", () => {
  const shown = { path: "docs/a.md", loading: false, kind: "markdown" as const, text: "# a" };
  assert.equal(keepsShownContent(shown, "docs/a.md"), true);
  // An image is held by its object URL, a refusal by its note — both count.
  assert.equal(keepsShownContent({ path: "a.png", loading: false, objectUrl: "blob:x" }, "a.png"), true);
  assert.equal(keepsShownContent({ path: "a.zip", loading: false, note: "unsupported" }, "a.zip"), true);
});

test("a different file, or one never rendered, loads openly", () => {
  const shown = { path: "docs/a.md", loading: false, text: "# a" };
  assert.equal(keepsShownContent(shown, "docs/b.md"), false);
  assert.equal(keepsShownContent({ path: "docs/a.md", loading: true }, "docs/a.md"), false);
  assert.equal(keepsShownContent({ path: "docs/a.md", loading: false }, "docs/a.md"), false);
});

test("an HTML file is framed as a page, sandboxed, with its source one click away", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(FileView, {
      content: {
        path: "docs/report.html",
        loading: false,
        kind: "html" as const,
        previewUrl: "/api/peons/nova/projects/OVSR/files/docs/report.html",
        text: "<h1>Report</h1>",
      },
    }),
  ));
  assert.match(html, /<iframe/);
  assert.match(html, /src="\/api\/peons\/nova\/projects\/OVSR\/files\/docs\/report\.html"/);
  // An opaque origin: scripts may run in the page, never against Overseer's
  // cookie on its own origin.
  assert.match(html, /sandbox="allow-scripts allow-forms allow-modals allow-downloads"/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, />Source</);
});

test("a page read back without its source offers no toggle", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(FileView, {
      content: { path: "big.html", loading: false, kind: "html" as const, previewUrl: "/api/x/big.html" },
    }),
  ));
  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, />Source</);
});
