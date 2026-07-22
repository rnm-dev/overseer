import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { sessionStatusLightClass, SessionSidebarList } from "./SessionSidebarList";

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

test("stale catalog rows are visibly marked without changing their session status", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(SessionSidebarList, {
        sessions: [{ peonId: "peon-1", id: "session-1", title: "Last known", status: "running", catalogState: "offline", catalogStale: true }],
        to: () => "/sessions/session-1",
        peonIdFor: () => "peon-1",
        viewersFor: () => [],
      }),
    ),
  ));

  assert.match(markup, />stale</);
  assert.match(markup, /opacity-70/);
  assert.match(markup, /bg-fel/);
});

test("session lights prioritize running green, then unread completion amber", () => {
  assert.match(sessionStatusLightClass("running", true), /bg-fel-bright/);
  assert.match(sessionStatusLightClass("running", true), /shadow/);
  assert.match(sessionStatusLightClass("completed", true), /bg-forge/);
  assert.match(sessionStatusLightClass("completed", true), /shadow/);
  assert.equal(sessionStatusLightClass("completed", false), "bg-iron-700");
});
