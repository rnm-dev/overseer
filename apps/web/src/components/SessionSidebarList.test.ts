import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "../i18n";
import { NotificationsProvider } from "../notifications";
import { sessionContextMenuPosition, sessionRenameDraft, sessionStatusEdgeClass, SessionSidebarList } from "./SessionSidebarList";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("session rows fade the latest message inline between project metadata and time", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      NotificationsProvider,
      null,
      React.createElement(MemoryRouter, null, React.createElement(SessionSidebarList, {
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
        onRename: async () => {},
        onDelete: async () => {},
      })),
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
      NotificationsProvider,
      null,
      React.createElement(MemoryRouter, null, React.createElement(SessionSidebarList, {
        sessions: [{ peonId: "peon-1", id: "session-1", title: "Last known", status: "running", catalogState: "offline", catalogStale: true }],
        to: () => "/sessions/session-1",
        peonIdFor: () => "peon-1",
        viewersFor: () => [],
        onRename: async () => {},
        onDelete: async () => {},
      })),
    ),
  ));

  assert.match(markup, />stale</);
  assert.match(markup, /opacity-70/);
  assert.match(markup, /bg-accent/);
});

test("session rows do not render a kebab menu trigger", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      NotificationsProvider,
      null,
      React.createElement(MemoryRouter, null, React.createElement(SessionSidebarList, {
        sessions: [
          { peonId: "peon-1", id: "session-1", title: "First" },
          { peonId: "peon-1", id: "session-2", title: "Second" },
        ],
        to: (session: { id: string }) => `/sessions/${session.id}`,
        peonIdFor: () => "peon-1",
        viewersFor: () => [],
        onRename: async () => {},
        onDelete: async () => {},
      })),
    ),
  ));

  assert.doesNotMatch(markup, /aria-haspopup="menu"/);
  assert.doesNotMatch(markup, /aria-label="More"/);
});

test("session context menu stays inside the viewport near every edge", () => {
  assert.deepEqual(sessionContextMenuPosition(300, 200, 800, 600), { x: 300, y: 200 });
  assert.deepEqual(sessionContextMenuPosition(799, 599, 800, 600), { x: 632, y: 510 });
  assert.deepEqual(sessionContextMenuPosition(-20, -10, 800, 600), { x: 8, y: 8 });
});

test("rename starts from the title currently displayed in the sidebar", () => {
  assert.equal(sessionRenameDraft({ id: "named", title: "Current title", promptPreview: "Opening prompt" }), "Current title");
  assert.equal(sessionRenameDraft({ id: "prompt", title: null, promptPreview: "Opening prompt" }), "Opening prompt");
  assert.equal(sessionRenameDraft({ id: "empty", title: null, promptPreview: null }), "");
});

test("session status edges prioritize running green, then unread completion amber", () => {
  assert.match(sessionStatusEdgeClass("running", true), /bg-accent-strong/);
  assert.match(sessionStatusEdgeClass("running", true), /status-edge status-edge--accent/);
  assert.match(sessionStatusEdgeClass("completed", true), /bg-warning/);
  assert.match(sessionStatusEdgeClass("completed", true), /status-edge status-edge--warning/);
  assert.equal(sessionStatusEdgeClass("completed", false), "bg-ink-faint/40");
});
