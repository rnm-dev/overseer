import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "../i18n";
import { sessionHeaderIdentityData, SessionHeaderIdentity, SessionHeaderStats } from "./peon/session/SessionHeader";
import { MobilePaneIdentity, MOBILE_CONTENT_HEADER_ID } from "./peon/session/mobileHeader";
import { ProjectHeaderLayout, ProjectMobileHeader } from "./peon/ProjectPageHeader";

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

test("session identity uses the indexed row immediately without leaking previous metadata", () => {
  assert.deepEqual(
    sessionHeaderIdentityData("peon-1:old", "peon-1:new", "Old title", "Old opening", "old-project", {
      title: "Indexed title",
      promptPreview: "Indexed opening",
      projectKey: "overseer",
    }),
    {
      title: "Indexed title",
      openingMessage: "Indexed opening",
      projectKey: "overseer",
      draft: "Indexed title",
      metadataLoading: false,
    },
  );
  // An untitled session is named by its indexed opening message, so it shows
  // the same thing the sidebar row does instead of a shimmer.
  assert.deepEqual(
    sessionHeaderIdentityData("peon-1:old", "peon-1:new", "Old title", "Old opening", "old-project", { promptPreview: "  Fix the header  " }),
    {
      title: null,
      openingMessage: "Fix the header",
      projectKey: null,
      draft: "",
      metadataLoading: false,
    },
  );
  assert.equal(sessionHeaderIdentityData("peon-1:old", "peon-1:new", "Old title", "Old opening", "old-project", undefined).metadataLoading, true);
  assert.equal(sessionHeaderIdentityData("peon-1:old", "peon-1:new", "Old title", "Old opening", "old-project", {}).metadataLoading, true);
  assert.equal(sessionHeaderIdentityData("peon-1:new", "peon-1:new", null, null, "overseer", { title: "Stale indexed title" }).metadataLoading, true);
  assert.equal(sessionHeaderIdentityData("peon-1:new", "peon-1:new", "Named session", null, null, undefined).metadataLoading, false);
  assert.equal(sessionHeaderIdentityData("peon-1:new", "peon-1:new", null, "Opening request", null, undefined).metadataLoading, false);
  // Once the record is loaded it is the only source — a stale indexed project
  // never survives a session whose record no longer carries one.
  assert.equal(sessionHeaderIdentityData("peon-1:new", "peon-1:new", "Named session", null, null, { projectKey: "overseer" }).projectKey, null);

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

test("desktop project header uses the session content header hierarchy", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(ProjectHeaderLayout, {
      title: "Overseer",
      newSessionTo: "/peons/nova/sessions/new?project=OVSR",
    })),
  ));

  assert.match(html, /space-y-1\.5 px-3 py-2\.5 sm:px-6/);
  assert.match(html, /min-h-7 gap-3/);
  assert.match(html, /typo-content-header[^"]*font-semibold text-warning" title="Overseer">Overseer<\/h1>/);
  assert.match(html, /btn btn-accent btn-sm h-7.*\+ New session<\/a>/);
  assert.doesNotMatch(html, /← Projects/);
  assert.doesNotMatch(html, /href="\/peons\/nova\/projects"/);
  assert.doesNotMatch(html, />OVSR<\/span>/);
});

test("desktop project loading reuses the session identity skeleton", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(ProjectHeaderLayout, {
      title: "OVSR",
      newSessionTo: "/peons/nova/sessions/new?project=OVSR",
      loading: true,
    })),
  ));

  assert.match(html, /role="status"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /h-3\.5 w-16/);
  assert.match(html, /h-3\.5 w-44/);
  assert.doesNotMatch(html, />OVSR<\/h1>/);
});

test("project overview can move the desktop new-session action into its content", () => {
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MemoryRouter, null, React.createElement(ProjectHeaderLayout, {
      title: "Overseer",
      newSessionTo: "/peons/nova/sessions/new?project=OVSR",
      showNewSession: false,
    })),
  ));

  assert.match(html, />Overseer<\/h1>/);
  assert.doesNotMatch(html, /\+ New session/);
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
