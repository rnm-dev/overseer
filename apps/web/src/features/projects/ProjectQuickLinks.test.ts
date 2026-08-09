import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../shared/i18n";
import { ProjectQuickLinksCard, orderedQuickLinks } from "./ProjectQuickLinks";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("quick links keep Peon order and open through safe external anchors", () => {
  const links = [
    { id: "later", title: "Runbook", url: "https://example.test/runbook", order: 8 },
    { id: "first", title: "Docs", url: "https://example.test/docs", order: 2 },
  ];
  assert.deepEqual(orderedQuickLinks(links).map((link) => link.id), ["first", "later"]);

  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ProjectQuickLinksCard, { links }),
  ));
  assert.match(html, />Quick Links</);
  assert.ok(html.indexOf(">Docs<") < html.indexOf(">Runbook<"));
  assert.match(html, /href="https:\/\/example\.test\/docs"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
