import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../shared/i18n";
import { PathInput, isPathWithin, normalizeAbsolutePath, pathFromRoot, relativeToRoot, virtualDirectoryNames } from "./PathInput";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("path fields use the technical monospace typography", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(PathInput, {
      base: "/peon",
      value: "/rnm/overseer",
      onChange: () => undefined,
    }),
  ));

  assert.match(markup, /<input class="field pr-11 path-field"/);
});

test("directory typography stays compact on desktop without triggering mobile focus zoom", () => {
  const css = readFileSync(new URL("../../app/index.css", import.meta.url), "utf8");
  const component = readFileSync(new URL("./PathInput.tsx", import.meta.url), "utf8");

  assert.match(css, /\.field\.path-field\s*\{[^}]*font-size:\s*0\.8rem;/s);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.field\.path-field\s*\{[^}]*font-size:\s*16px;/);
  assert.match(component, /font-mono text-\[0\.6875rem\] leading-4/);
  assert.match(component, /font-mono text-xs leading-4 text-ink-muted/);
});

test("path selector normalizes and joins absolute paths", () => {
  assert.equal(normalizeAbsolutePath("/srv//projects/../repos/"), "/srv/repos");
  assert.equal(pathFromRoot("/", "home/peon"), "/home/peon");
  assert.equal(pathFromRoot("/srv/files/", "projects/app"), "/srv/files/projects/app");
});

test("relative API paths are derived only for values inside a browse root", () => {
  assert.equal(relativeToRoot("/srv/files/projects/app", "/srv/files"), "projects/app");
  assert.equal(relativeToRoot("/srv/files", "/srv/files"), "");
  assert.equal(relativeToRoot("/home/peon", "/srv/files"), "");
});

test("breadcrumb ancestors expose known project folders until a real browse root is reached", () => {
  const locations = [
    { root: "/rnm/overseer", base: "/projects/overseer/files" },
    { root: "/rnm/heroboard", base: "/projects/heroboard/files" },
    { root: "/kundelik/app", base: "/projects/app/files" },
  ];
  assert.deepEqual(virtualDirectoryNames("/", locations), ["kundelik", "rnm"]);
  assert.deepEqual(virtualDirectoryNames("/rnm", locations), ["heroboard", "overseer"]);
  assert.equal(isPathWithin("/rnm/overseer/web", "/rnm/overseer"), true);
  assert.equal(isPathWithin("/rnm/heroboard", "/rnm/overseer"), false);
});
