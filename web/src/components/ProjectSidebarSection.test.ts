import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { ProjectSidebarSection, projectStatusLightClass, sidebarProjects } from "./ProjectSidebarSection";

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
  assert.match(markup, /justify-between pb-1 pl-3\.5 pr-1 pt-2/);
  assert.match(markup, /block rounded px-2\.5 py-1\.5 transition-colors bg-fel\/10/);
  assert.match(markup, /font-display text-\[0\.8rem\] text-bone/);
  assert.match(markup, />3 members</);
  assert.match(markup, />•</);
  assert.match(markup, />2 active</);
  assert.match(markup, />8 sessions</);
  assert.doesNotMatch(markup, />\/rnm\/overseer</);
});

test("project status light glows only while the project has active sessions", () => {
  assert.match(projectStatusLightClass(1), /bg-fel-bright/);
  assert.match(projectStatusLightClass(1), /shadow/);
  assert.equal(projectStatusLightClass(0), "bg-iron-700");
  assert.equal(projectStatusLightClass(), "bg-iron-700");
});
