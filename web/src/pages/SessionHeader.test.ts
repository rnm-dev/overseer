import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../i18n";
import { SessionHeaderIdentity } from "./peon/session/SessionHeader";

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
      firstUserMessage: null,
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
