import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { sessionHeaderMetadataLoading, SessionHeaderIdentity, SessionHeaderStats } from "./peon/session/SessionHeader";
import { MobilePaneIdentity, MOBILE_CONTENT_HEADER_ID } from "./peon/session/mobileHeader";
import { ProjectMobileHeader } from "./peon/ProjectPageHeader";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function renderIdentity(metadataLoading: boolean) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(SessionHeaderIdentity, {
      peonId: "peon-1",
      metadataLoading,
      projectKey: metadataLoading ? null : "overseer",
      title: metadataLoading ? null : "Loaded title",
      draft: metadataLoading ? "" : "Loaded title",
      openingMessage: null,
      editing: false,
      savingName: false,
      setDraft: () => {},
      setEditing: () => {},
      setRenameNote: () => {},
      saveName: async () => {},
      cancelRename: () => {},
    })),
  ));
}

test("session identity stays a shimmer until its metadata is loaded", () => {
  const loading = renderIdentity(true);

  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /animate-pulse/);
  assert.doesNotMatch(loading, /Untitled session/);
  assert.doesNotMatch(loading, /<input/);
});

test("session identity reveals the project and title after metadata loads", () => {
  const loaded = renderIdentity(false);

  assert.match(loaded, />Overseer<\/a>/);
  assert.match(loaded, /value="Loaded title"/);
  assert.doesNotMatch(loaded, /aria-busy="true"/);
});

test("session identity waits for a title or the authoritative conversation opening", () => {
  assert.equal(sessionHeaderMetadataLoading("peon-1:old", "peon-1:new", "Old title", "Old opening"), true);
  assert.equal(sessionHeaderMetadataLoading("peon-1:new", "peon-1:new", null, null), true);
  assert.equal(sessionHeaderMetadataLoading("peon-1:new", "peon-1:new", "Named session", null), false);
  assert.equal(sessionHeaderMetadataLoading("peon-1:new", "peon-1:new", null, "Opening request"), false);

  const waitingForDisplayTitle = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(SessionHeaderIdentity, {
      peonId: "peon-1",
      metadataLoading: true,
      projectKey: "overseer",
      title: null,
      draft: "",
      openingMessage: null,
      editing: false,
      savingName: false,
      setDraft: () => {},
      setEditing: () => {},
      setRenameNote: () => {},
      saveName: async () => {},
      cancelRename: () => {},
    })),
  ));

  assert.match(waitingForDisplayTitle, /aria-busy="true"/);
  assert.doesNotMatch(waitingForDisplayTitle, /Untitled session/);
  assert.doesNotMatch(waitingForDisplayTitle, /<input/);

  const promptFallback = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(SessionHeaderIdentity, {
      peonId: "peon-1",
      metadataLoading: false,
      projectKey: "overseer",
      title: null,
      draft: "",
      openingMessage: "Authoritative session prompt",
      editing: false,
      savingName: false,
      setDraft: () => {},
      setEditing: () => {},
      setRenameNote: () => {},
      saveName: async () => {},
      cancelRename: () => {},
    })),
  ));

  assert.match(promptFallback, />Overseer<\/a>/);
  assert.match(promptFallback, /placeholder="Authoritative session prompt"/);
  assert.doesNotMatch(promptFallback, /aria-busy="true"/);
});

test("mobile content pages replace Peon chrome with the shared header slot", () => {
  const session = renderToStaticMarkup(React.createElement(
    MobilePaneIdentity,
    { contentActive: true },
    React.createElement("span", null, "Nova — Sessions"),
  ));
  const peon = renderToStaticMarkup(React.createElement(
    MobilePaneIdentity,
    { contentActive: false },
    React.createElement("span", null, "Nova"),
  ));

  assert.match(session, new RegExp(`id="${MOBILE_CONTENT_HEADER_ID}"`));
  assert.doesNotMatch(session, /Nova|Sessions/);
  assert.match(peon, /Nova/);
});

test("mobile project header shows only the project title and new-session action in the navbar", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(ProjectMobileHeader, {
      title: "Overseer",
      newSessionTo: "/peons/nova/sessions/new?project=OVSR",
    })),
  ));

  assert.match(html, /title="Overseer">Overseer<\/div>/);
  assert.match(html, />\+ New session<\/a>/);
  assert.doesNotMatch(html, /href="\/peons\/nova\/projects"/);
  assert.doesNotMatch(html, />OVSR<\/div>/);
  assert.doesNotMatch(html, /px-3 py-2\.5/);
});

test("session stats stay available in the compact mobile header", () => {
  const stats = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(SessionHeaderStats, {
      turnTotal: 3,
      usageSummary: { input: 1200, output: 456, cacheCreate: 0, cacheRead: 0, costUsd: 1.25 },
    }),
  ));

  assert.match(stats, /3 turns/);
  assert.match(stats, /1\.2K input/);
  assert.match(stats, /456 output/);
  assert.doesNotMatch(stats, /\$1\.25/);
});
