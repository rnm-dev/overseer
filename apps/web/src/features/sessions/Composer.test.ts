import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../shared/i18n";
import { Composer, MAX_TEXTAREA_HEIGHT, isFileDrag } from "./Composer";
import { COMPOSER_FOOTER_PADDING, composerFooterHeight } from "./SessionComposerDock";

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

test("inline mention paint uses exactly the textarea typography and does not change glyph width", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "@vibze hello",
      highlightedMentions: [{ startUtf16: 0, lengthUtf16: 6 }],
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

  assert.match(markup, /composer-input pointer-events-none/);
  assert.doesNotMatch(markup, /font-semibold/);
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

test("a draft carrying attachments by path shows them and can be sent with no text", () => {
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
      carried: [{ type: "file", path: "/tmp/peon-files/uploads/session/plan.md" }],
      onCarriedChange: () => undefined,
      onPreviewFile: () => undefined,
      filesEnabled: true,
      error: null,
      onErrorChange: () => undefined,
    }),
  ));

  // Named by its basename: the bytes are on the peon, not in this browser.
  assert.match(markup, /plan\.md/);
  assert.match(markup, /title="\/tmp\/peon-files\/uploads\/session\/plan\.md"/);
  // A queued message pulled back in may carry attachments and no text — the
  // submit button has to accept that as a message. The accent styling is only
  // applied while it can be submitted.
  assert.match(markup, /bg-accent text-on-accent/);
});

test("carrying nothing leaves the attachment row out entirely", () => {
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(Composer, {
      value: "hello",
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
  assert.doesNotMatch(markup, /📎/);
});
