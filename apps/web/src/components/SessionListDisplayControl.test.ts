import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../i18n";
import {
  displayMenuPosition,
  loadSessionListDisplayMode,
  loadSessionListProjectLimit,
  normalizeSessionListProjectLimit,
  saveSessionListDisplayMode,
  saveSessionListProjectLimit,
  SessionListDisplayControl,
} from "./SessionListDisplayControl";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("session display preferences default to grouped and accept bounded integer limits", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  assert.equal(loadSessionListDisplayMode(storage), "grouped");
  assert.equal(loadSessionListProjectLimit(storage), 5);
  saveSessionListDisplayMode("flat", storage);
  saveSessionListProjectLimit(10, storage);
  assert.equal(loadSessionListDisplayMode(storage), "flat");
  assert.equal(loadSessionListProjectLimit(storage), 10);
  values.set("overseer:session-list:project-limit", "17");
  assert.equal(loadSessionListProjectLimit(storage), 17);
  values.set("overseer:session-list:project-limit", "100");
  assert.equal(loadSessionListProjectLimit(storage), 5);
  assert.equal(normalizeSessionListProjectLimit(0), 1);
  assert.equal(normalizeSessionListProjectLimit(7.6), 8);
  assert.equal(normalizeSessionListProjectLimit(120), 99);
});

test("desktop display menu stays inside the viewport", () => {
  const rect = { right: 790, bottom: 590 } as DOMRect;
  assert.deepEqual(displayMenuPosition(rect, 800, 600), { x: 550, y: 342 });
  assert.deepEqual(displayMenuPosition({ right: 10, bottom: 10 } as DOMRect, 800, 600), { x: 8, y: 16 });
});

test("display control reuses the recent-section header and plain action treatment", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(SessionListDisplayControl, {
      mode: "grouped",
      projectLimit: 5,
      onModeChange: () => {},
      onProjectLimitChange: () => {},
    }),
  ));
  assert.match(markup, /bg-ink\/5 px-3 py-1\.5 font-display text-\[0\.55rem\]/);
  assert.match(markup, /^<div class="border-b border-edge\/70">/);
  assert.match(markup, /class="uppercase text-ink-muted transition-colors hover:text-accent-strong"/);
  assert.doesNotMatch(markup, /sliders-horizontal|rounded-md px-2/);
});
