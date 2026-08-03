import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "../../i18n";
import { NotificationsProvider } from "../../notifications";
import { isProjectPath } from "../PeonDetail";
import { ProjectRecentSessions, recentProjectSessions } from "./PeonProjectDetail";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("all project routes opt into the full-width content pane", () => {
  assert.equal(isProjectPath("/peons/nova/projects/OVSR"), true);
  assert.equal(isProjectPath("/peons/nova/projects/OVSR/"), true);
  assert.equal(isProjectPath("/peons/nova/projects/OVSR/files"), true);
  assert.equal(isProjectPath("/peons/nova/projects/OVSR/skills"), true);
  assert.equal(isProjectPath("/peons/nova/projects/OVSR/members"), true);
  assert.equal(isProjectPath("/peons/nova/projects/OVSR/settings"), true);
  assert.equal(isProjectPath("/peons/nova/projects"), false);
  assert.equal(isProjectPath("/peons/nova/sessions/session-1"), false);
});

test("recent project sessions filter by project, order by activity, and stay bounded", () => {
  const sessions = [
    { id: "other", projectKey: "OTHER", lastActivityAt: 500 },
    { id: "older", projectKey: "OVSR", lastActivityAt: 100 },
    { id: "newer", projectKey: "OVSR", lastActivityAt: 300 },
    { id: "started", projectKey: "OVSR", startedAt: 200 },
  ];

  assert.deepEqual(
    recentProjectSessions(sessions, "OVSR", 2).map((session) => session.id),
    ["newer", "started"],
  );
});

test("recent project sessions include rows the sidebar page never reached", () => {
  const sidebar = [{ id: "in-page", peonId: "nova", projectKey: "OVSR", status: "running", lastActivityAt: 300, syncedAt: 9 }];
  const projectPage = [
    { id: "in-page", peonId: "nova", projectKey: "OVSR", status: "done", lastActivityAt: 300, syncedAt: 4 },
    { id: "beyond-page", peonId: "nova", projectKey: "OVSR", lastActivityAt: 100, syncedAt: 4 },
  ];

  const recent = recentProjectSessions(sidebar, "OVSR", 8, projectPage);
  assert.deepEqual(recent.map((session) => session.id), ["in-page", "beyond-page"]);
  // The sidebar row is the live one, so its status wins over the fetched page.
  assert.equal(recent[0].status, "running");
});

test("project recent sessions reuse sidebar rows with status, presence hook, and session navigation", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      NotificationsProvider,
      null,
      React.createElement(MemoryRouter, null, React.createElement(ProjectRecentSessions, {
        projectKey: "OVSR",
        peonId: "nova",
        newSessionTo: "/peons/nova/sessions/new?project=OVSR",
        sessions: [
          { id: "live", projectKey: "OVSR", title: "Live work", status: "running", lastActivityAt: 300 },
          { id: "other", projectKey: "OTHER", title: "Wrong project", lastActivityAt: 400 },
        ],
        loading: false,
        error: false,
        viewersFor: () => [],
        onRename: async () => {},
        onDelete: async () => {},
      })),
    ),
  ));

  assert.match(html, /Recent sessions/);
  assert.match(html, /Live work/);
  assert.match(html, /bg-accent-strong/);
  assert.match(html, /href="\/peons\/nova\/sessions\/live"/);
  assert.match(html, /href="\/peons\/nova\/sessions\/new\?project=OVSR".*\+ New session<\/a>/);
  assert.match(html, /hover:bg-surface-hover\/70/);
  // The row's status now reads off the glowing left edge, so the panel no longer
  // needs its own inset hover marker.
  assert.match(html, /class="absolute inset-y-1 left-0 w-0\.5 bg-accent-strong status-edge/);
  assert.doesNotMatch(html, /hover:shadow-\[inset_2px_0_0_var\(--color-accent\)\]/);
  assert.doesNotMatch(html, /Wrong project/);
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const footer = html.slice(html.indexOf("<footer"), html.indexOf("</footer>"));
  assert.doesNotMatch(header, /<svg|title="OVSR"|h-10 w-10/);
  assert.doesNotMatch(header, />1<\/span>/);
  assert.match(footer, />1 sessions$/);
});
