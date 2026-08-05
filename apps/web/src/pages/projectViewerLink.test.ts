import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { Markdown } from "../components/RichText";
import { projectViewerHref, projectViewerRelativePath, type ProjectViewerContext } from "./peon/session/projectViewerLink";

const context: ProjectViewerContext = {
  peonId: "peon/id",
  projectId: "project id",
  projectRoot: "/rnm/websitev2",
  currentOrigin: "https://overseer.rnm.dev",
};

test("project files map from absolute host paths to stable browser viewer URLs", () => {
  assert.equal(
    projectViewerHref("/rnm/websitev2/docs/ivr sales.html#flow", context),
    "/view/peon%2Fid/project%20id/docs/ivr%20sales.html#flow",
  );
  assert.equal(
    projectViewerHref("file:///rnm/websitev2/docs/index.html", context),
    "/view/peon%2Fid/project%20id/docs/index.html",
  );
  assert.equal(
    projectViewerHref("https://overseer.rnm.dev/rnm/websitev2/docs/index.html?print=1", context),
    "/view/peon%2Fid/project%20id/docs/index.html?print=1",
  );
  assert.equal(
    projectViewerHref("C:\\work\\site\\docs\\index.html", { ...context, projectRoot: "C:\\work\\site" }),
    "/view/peon%2Fid/project%20id/docs/index.html",
  );
});

test("cited source positions never become part of the file name", () => {
  assert.equal(
    projectViewerHref("/rnm/websitev2/apps/backend/src/app.ts:312", context),
    "/view/peon%2Fid/project%20id/apps/backend/src/app.ts",
  );
  assert.equal(
    projectViewerHref("/rnm/websitev2/apps/backend/src/app.ts:312:4", context),
    "/view/peon%2Fid/project%20id/apps/backend/src/app.ts",
  );
  assert.equal(
    projectViewerHref("file:///rnm/websitev2/docs/index.html#L12", context),
    "/view/peon%2Fid/project%20id/docs/index.html#L12",
  );
});

test("external, sibling, root, relative, and traversing links are never rewritten", () => {
  assert.equal(projectViewerHref("https://example.com/rnm/websitev2/docs/index.html", context), null);
  assert.equal(projectViewerHref("/rnm/websitev20/docs/index.html", context), null);
  assert.equal(projectViewerHref("/rnm/websitev2", context), null);
  assert.equal(projectViewerHref("docs/index.html", context), null);
  assert.equal(projectViewerHref("/rnm/websitev2/docs/../secret.html", context), null);
});

test("Markdown emits the transformed viewer URL as the real copyable href", () => {
  const markup = renderToStaticMarkup(createElement(Markdown, {
    source: "[Open preview](/rnm/websitev2/docs/ivr-sales-script.html)",
    transformLink: (href: string) => projectViewerHref(href, context),
    onOpenFile: () => {
      throw new Error("rewritten viewer links must not use the session preview click handler");
    },
  }));
  assert.match(markup, /href="\/view\/peon%2Fid\/project%20id\/docs\/ivr-sales-script\.html"/);
  assert.match(markup, /target="_blank"/);
});

test("canonical viewer URLs map back to project-relative paths for the chat viewer", () => {
  assert.equal(
    projectViewerRelativePath("/view/peon%2Fid/project%20id/docs/ivr%20sales.html#flow", context),
    "docs/ivr sales.html",
  );
  assert.equal(projectViewerRelativePath("/view/other/project%20id/docs/index.html", context), null);
  assert.equal(projectViewerRelativePath("/view/peon%2Fid/project%20id/docs/%2E%2E/secret.html", context), null);
});
