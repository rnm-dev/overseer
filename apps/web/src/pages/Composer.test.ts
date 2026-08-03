import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../i18n";
import { COMPOSER_ICON_ACTION_CLASS, COMPOSER_SHELL_CLASS, COMPOSER_TEXT_ACTION_CLASS, Composer, MAX_TEXTAREA_HEIGHT, isFileDrag } from "./peon/Composer";
import { COMPOSER_FOOTER_PADDING, SESSION_COMPOSER_DOCK_CLASS, SESSION_COMPOSER_FADE_CLASS, composerFooterHeight } from "./peon/session/SessionComposerDock";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("composer exposes the shared file drop zone", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Send",
      disabled: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  assert.match(markup, /data-file-drop-zone="composer"/);
  assert.match(markup, /type="file"/);
  assert.match(COMPOSER_SHELL_CLASS, /\bsurface\b/);
  assert.match(COMPOSER_SHELL_CLASS, /\btheme-composer-shell\b/);
  assert.doesNotMatch(COMPOSER_SHELL_CLASS, /focus-within:/);
  assert.match(COMPOSER_SHELL_CLASS, /\bp-2\b/);
  assert.match(COMPOSER_ICON_ACTION_CLASS, /\bon-surface\b/);
  assert.match(COMPOSER_ICON_ACTION_CLASS, /\bh-8\b/);
  assert.match(COMPOSER_ICON_ACTION_CLASS, /\bw-8\b/);
  assert.match(COMPOSER_ICON_ACTION_CLASS, /\brounded-lg\b/);
  assert.match(COMPOSER_TEXT_ACTION_CLASS, /\bon-surface\b/);
});

test("composer dock uses the package-owned transcript fade", () => {
  assert.match(SESSION_COMPOSER_FADE_CLASS, /\btheme-transcript-composer-fade\b/);
  assert.doesNotMatch(SESSION_COMPOSER_FADE_CLASS, /from-void|via-void/);
  // The fade wraps the composer alone, so queued messages stacking above it
  // leave the shade where it was instead of pushing it up the transcript.
  assert.doesNotMatch(SESSION_COMPOSER_DOCK_CLASS, /\btheme-transcript-composer-fade\b/);
});

test("the transcript reserves room for queued messages stacked above the composer", () => {
  const composerOnly = 92;
  const withQueue = 320;
  assert.equal(composerFooterHeight(composerOnly, 900), COMPOSER_FOOTER_PADDING);
  assert.equal(composerFooterHeight(withQueue, 900), withQueue);
  // A queue taller than the viewport still leaves half the screen for the
  // conversation it was queued against.
  assert.equal(composerFooterHeight(withQueue, 400), 200);
});

test("composer dock leaves its right edge to the scrollbar-aware stylesheet", () => {
  // .session-composer owns `right` so the fade stops before the transcript
  // scrollbar; a utility right-0 here would paint over it again.
  assert.doesNotMatch(SESSION_COMPOSER_DOCK_CLASS, /\bright-0\b/);
  assert.match(SESSION_COMPOSER_DOCK_CLASS, /\bsession-composer\b/);
});

test("the auto-size cap matches the textarea's painted max height", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "first line\nsecond line\nthird line",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Send",
      disabled: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  // The restored draft grows the textarea imperatively up to this cap; letting
  // the two drift would either clip the content or overflow the shell.
  assert.match(markup, /\bmax-h-40\b/);
  assert.equal(MAX_TEXTAREA_HEIGHT, 40 * 4); // Tailwind spacing unit = 4px
});

test("file drag detection ignores ordinary text and link drags", () => {
  assert.equal(isFileDrag(["Files"]), true);
  assert.equal(isFileDrag(["text/plain", "text/uri-list"]), false);
});

test("an unavailable composer is disabled without showing an in-flight spinner", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "queued draft",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Send",
      disabled: true,
      pending: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  assert.match(markup, /disabled=""/);
  assert.doesNotMatch(markup, /animate-spin/);
  assert.match(markup, /\bon-surface\b/);
  assert.doesNotMatch(markup, /\brounded-full\b/);
});

test("queue mode uses a square hourglass action instead of a text label", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "next prompt",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Queue",
      submitIcon: "queue",
      disabled: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  assert.match(markup, /lucide-hourglass/);
  assert.doesNotMatch(markup, />Queue</);
  assert.match(markup, /\bh-8 w-8\b/);
});

test("mobile stop-and-queue action uses a compact lightning icon", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "urgent follow-up",
      onChange: () => undefined,
      onSubmit: () => undefined,
      placeholder: "Message",
      submitTitle: "Queue",
      submitIcon: "queue",
      disabled: false,
      files: [],
      onFilesChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
      secondaryAction: {
        label: "Queue & stop",
        mobileIcon: "zap",
        onClick: () => undefined,
      },
    }),
  ));

  assert.match(markup, /aria-label="Queue &amp; stop"/);
  assert.match(markup, /lucide-zap/);
  assert.match(markup, /class="hidden sm:inline">Queue &amp; stop/);
  assert.match(markup, /\bh-8 w-8\b/);
});
