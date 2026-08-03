import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "../i18n";
import { NotificationsProvider } from "../notifications";
import {
  CollapsedProjectStatusBadges,
  groupSessionsByProject,
  loadExpandedProjectGroups,
  projectSessionStatusCounts,
  ProjectGroupedSessionList,
  saveExpandedProjectGroups,
} from "./ProjectGroupedSessionList";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("sessions group by stable project id with key and unassigned fallbacks", () => {
  const groups = groupSessionsByProject(
    [
      { projectId: "p-z", key: "renamed", name: "Zulu" },
      { projectId: "p-a", key: "alpha", name: "Alpha" },
    ],
    [
      { id: "stable", projectId: "p-z", projectKey: "old-key" },
      { id: "legacy", projectKey: "alpha" },
      { id: "none" },
    ],
  );

  assert.deepEqual(groups.map((group) => group.id), ["id:p-a", "id:p-z", "unassigned"]);
  assert.deepEqual(groups.map((group) => group.sessions.map((session) => session.id)), [["legacy"], ["stable"], ["none"]]);
});

test("collapsed project status badges count and style working and unread sessions independently", () => {
  const sessions = [
    { id: "running-unread", status: "running", attentionUnread: true },
    { id: "running", status: "running" },
    { id: "unread", status: "completed", attentionUnread: true },
    { id: "idle", status: "completed" },
  ];
  assert.deepEqual(projectSessionStatusCounts(sessions), { working: 2, unread: 2 });

  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(CollapsedProjectStatusBadges, { sessions }),
  ));
  assert.match(markup, /bg-accent\/\[0\.06\]/);
  assert.match(markup, /bg-warning\/\[0\.06\]/);
  assert.match(markup, /bg-accent-strong status-edge status-edge--accent/);
  assert.match(markup, /bg-warning status-edge status-edge--warning/);
  assert.match(markup, /Working sessions: 2/);
  assert.match(markup, /Unread sessions: 2/);
  assert.doesNotMatch(markup, /<a /);
});

test("collapsed project status badges link to the first working and unread session when navigation is available", () => {
  const sessions = [
    { id: "idle", status: "completed" },
    { id: "running", status: "running" },
    { id: "unread", status: "completed", attentionUnread: true },
  ];

  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(CollapsedProjectStatusBadges, {
      sessions,
      sessionTo: (session: { id: string }) => `/sessions/${session.id}`,
    })),
  ));

  assert.match(markup, /aria-label="Open a working session \(1\)" href="\/sessions\/running"/);
  assert.match(markup, /aria-label="Open an unread session \(1\)" href="\/sessions\/unread"/);
  assert.match(markup, /cursor-pointer transition-colors hover:bg-accent\/20 hover:text-accent-strong/);
  assert.match(markup, /cursor-pointer transition-colors hover:bg-warning\/20 hover:text-warning-strong/);
});

test("grouped sidebar renders collapsible project toolbars, limits rows, and ends with the new-project ghost", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      NotificationsProvider,
      null,
      React.createElement(MemoryRouter, null, React.createElement(ProjectGroupedSessionList, {
        projects: [{ projectId: "project-1", key: "OVSR", name: "Overseer", sessionCount: 12 }],
        sessions: [
          { id: "s1", projectId: "project-1", projectKey: "OVSR", title: "First" },
          { id: "s2", projectId: "project-1", projectKey: "OVSR", title: "Second" },
          { id: "s3", projectId: "project-1", projectKey: "OVSR", title: "Hidden by limit" },
        ],
        projectLimit: 2,
        peonId: "nova",
        viewersFor: () => [],
        projectTo: () => "/projects/OVSR",
        sessionTo: (session: { id: string }) => `/sessions/${session.id}`,
        newSessionTo: () => "/sessions/new?project=OVSR",
        onNewProject: () => {},
        onRename: async () => {},
        onDelete: async () => {},
      })),
    ),
  ));

  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /flex h-7 items-center bg-ink\/5/);
  assert.match(markup, /aria-label="Collapse sessions: Overseer"/);
  assert.match(markup, /title="Overseer"[^>]+href="\/projects\/OVSR"/);
  assert.match(markup, /h-7 min-w-0 flex-1 items-center truncate px-2 font-body typo-chat-message font-semibold text-ink/);
  assert.match(markup, /h-7 w-7 flex-none place-items-center border-r border-edge\/70/);
  assert.match(markup, /h-7 w-7 place-items-center border-l border-edge\/70 text-accent-strong/);
  assert.match(markup, /role="toolbar" aria-label="Overseer"/);
  assert.doesNotMatch(markup, /All sessions/);
  assert.match(markup, /aria-label="\+ New session: Overseer"/);
  assert.doesNotMatch(markup, />12 sessions</);
  assert.match(markup, /<ul class="py-1">/);
  assert.match(markup, />First</);
  assert.match(markup, />Second</);
  assert.doesNotMatch(markup, /Hidden by limit/);
  assert.ok(markup.indexOf("Second") < markup.lastIndexOf("New project"));
  assert.match(markup, /group flex h-7 w-full items-stretch border-b border-dashed/);
  assert.match(markup, /grid w-7 flex-none place-items-center border-r border-dashed border-edge/);
  assert.doesNotMatch(markup, />\+ New project</);
});

test("expanded project preferences are validated and persisted", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(loadExpandedProjectGroups(storage), null);
  saveExpandedProjectGroups(["id:a", "key:b"], storage);
  assert.deepEqual(loadExpandedProjectGroups(storage), ["id:a", "key:b"]);
  values.set("overseer:session-list:expanded-projects", "not-json");
  assert.equal(loadExpandedProjectGroups(storage), null);
});
