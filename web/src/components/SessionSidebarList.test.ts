import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { SessionSidebarList } from "./SessionSidebarList";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("session rows fade the latest message inline between project metadata and time", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(SessionSidebarList, {
        sessions: [{
          peonId: "peon-1",
          id: "session-1",
          title: "Named session",
          projectKey: "OVERSEER",
          lastMessagePreview: "Latest assistant response",
        }],
        to: () => "/sessions/session-1",
        peonIdFor: () => "peon-1",
        peonNameFor: () => "Serik",
        viewersFor: () => [],
      }),
    ),
  ));

  const peon = markup.indexOf("Serik");
  const project = markup.indexOf("OVERSEER");
  const preview = markup.indexOf("Latest assistant response");
  assert.ok(peon >= 0);
  assert.ok(project > peon);
  assert.ok(preview > project);
  assert.match(markup, /OVERSEER<\/span><span class="min-w-0 flex-1 whitespace-nowrap"[^>]*><span class="title-fade">Latest assistant response<\/span>/);
});
