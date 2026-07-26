import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import {
  loadProjectSidebarExpanded,
  PROJECT_SIDEBAR_EXPANDED_STORAGE_KEY,
  ProjectSidebarSection,
  projectContextMenuPosition,
  projectStatusEdgeClass,
  saveProjectSidebarExpanded,
  sidebarProjects,
} from "./ProjectSidebarSection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("sidebar projects excludes tombstones and sorts by display name", () => {
  assert.deepEqual(
    sidebarProjects([
      { key: "zulu" },
      { key: "hidden", deleted: true },
      { key: "bravo", name: "Alpha" },
    ]).map((project) => project.key),
    ["bravo", "zulu"],
  );
});

test("project sidebar renders a collapsible header and every visible project link", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/peons/nova/projects/OVERSEER"] },
      React.createElement(ProjectSidebarSection, {
        projects: [
          { key: "OVERSEER", path: "/rnm/overseer", activeCount: 2, sessionCount: 8, memberCount: 3 },
          { key: "WEBSITE", name: "RNM Website", path: "/rnm/websitev2" },
        ],
        to: (project: { key: string }) => `/peons/nova/projects/${project.key}`,
      }),
    ),
  ));

  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, />Projects</);
  assert.match(markup, />OVERSEER</);
  assert.match(markup, />RNM Website</);
  assert.match(markup, /aria-current="page"/);
  assert.match(markup, /bg-bone\/5 px-3 py-1\.5 font-display text-\[0\.55rem\] uppercase tracking-\[0\.16em\]/);
  assert.match(markup, /id="peon-sidebar-projects"/);
  assert.match(markup, /<ul class="py-1">/);
  assert.match(markup, /relative block min-w-0 flex-1 py-1\.5 pl-3 transition-colors pr-2 bg-fel\/10/);
  assert.match(markup, /class="absolute inset-y-1 left-0 w-0\.5 bg-fel-bright status-edge status-edge--fel"/);
  assert.match(markup, /font-display text-\[0\.8rem\] text-bone/);
  assert.match(markup, />3 members</);
  assert.match(markup, />•</);
  assert.match(markup, />2 active</);
  assert.match(markup, />8 sessions</);
  assert.doesNotMatch(markup, />\/rnm\/overseer</);
});

test("project status edge glows only while the project has active sessions", () => {
  assert.match(projectStatusEdgeClass(1), /bg-fel-bright/);
  assert.match(projectStatusEdgeClass(1), /status-edge status-edge--fel/);
  assert.equal(projectStatusEdgeClass(0), "bg-bone-faint/40");
  assert.equal(projectStatusEdgeClass(), "bg-bone-faint/40");
});

test("projects with quick links expose a discoverable context-menu button", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ProjectSidebarSection, {
        projects: [{ key: "OVSR", quickLinks: [{ id: "docs", title: "Docs", url: "https://example.test/docs", order: 0 }] }],
        to: (project: { key: string }) => `/peons/nova/projects/${project.key}`,
      }),
    ),
  ));
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-label="Quick Links: OVSR"/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(ProjectSidebarSection, {
      projects: [{ key: "EMPTY" }],
      to: (project: { key: string }) => `/projects/${project.key}`,
    })),
  )), /aria-haspopup="menu"/);
});

test("project quick-link menus stay within viewport bounds", () => {
  assert.deepEqual(projectContextMenuPosition(999, 999, 320, 480, 10), { x: 104, y: 152 });
  assert.deepEqual(projectContextMenuPosition(-20, -20, 320, 480, 1), { x: 8, y: 8 });
});

test("project sidebar expansion preference persists in local storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(loadProjectSidebarExpanded(storage), true);
  saveProjectSidebarExpanded(false, storage);
  assert.equal(values.get(PROJECT_SIDEBAR_EXPANDED_STORAGE_KEY), "false");
  assert.equal(loadProjectSidebarExpanded(storage), false);
  saveProjectSidebarExpanded(true, storage);
  assert.equal(loadProjectSidebarExpanded(storage), true);
});

test("project sidebar falls back to expanded when local storage is unavailable", () => {
  const unavailable = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
  };

  assert.equal(loadProjectSidebarExpanded(unavailable), true);
});
