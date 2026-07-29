import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { RouteTabs } from "./RouteTabs";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("route tabs render the shared settings tabbar treatment and active route", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/projects/OVSR/files"] },
      React.createElement(RouteTabs, {
        ariaLabel: "Project navigation",
        tabs: [
          { to: "/projects/OVSR", label: "Overview", end: true },
          { to: "/projects/OVSR/files", label: "Files" },
        ],
      }),
    ),
  );

  assert.match(html, /aria-label="Project navigation"/);
  assert.match(html, /overflow-x-auto/);
  assert.match(html, /href="\/projects\/OVSR"[^>]*>Overview<\/a>/);
  assert.match(html, /aria-current="page"[^>]*href="\/projects\/OVSR\/files"/);
  assert.match(html, /border-fel text-fel-bright/);
  assert.match(html, /px-4 py-2\.5 font-display text-sm font-bold/);
});
