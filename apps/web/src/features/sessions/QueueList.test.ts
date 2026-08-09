import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QUEUE_ACTION_CLASS, QUEUE_CONTENT_MIN_HEIGHT_CLASS, QUEUE_HOURGLASS_CLASS, QueueList } from "./QueueList";
import type { QueueItem } from "./queue";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const queuedItem: QueueItem = {
  id: "second",
  type: "queue",
  sessionId: "session",
  prompt: "Send this before the first item",
  attachments: [{ type: "file", path: "/tmp/plan.md", name: "plan.md" }],
  permissionMode: "full-access",
  author: "viktor@example.test",
  model: "gpt-5",
  reasoningEffort: "high",
  commandId: null,
  queuedAt: 2,
};

test("every queued item exposes an accessible steer action", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueueList, {
      items: [queuedItem],
      removing: new Set<string>(),
      steering: new Set<string>(),
      onRemove: () => {},
      onSteer: () => {},
      t: (key) => key === "session.queue.steer" ? "Направить" : key,
    }),
  );
  assert.match(html, /aria-label="Направить"/);
  assert.match(html, /class="hidden sm:inline">Направить<\/span>/);
  assert.match(html, /lucide-hourglass/);
  assert.match(html, /width="13"[^>]*lucide-hourglass/);
  assert.doesNotMatch(html, /size-8[^>]*>[\s\S]*?lucide-hourglass/);
  assert.doesNotMatch(html, /viktor@example\.test/);
  assert.match(html, /theme-queued-message/);
  assert.doesNotMatch(html, /bg-warning-deep/);
  assert.match(html, /backdrop-blur-md/);
  assert.match(html, /\bw-full\b/);
  assert.match(html, /\bmax-w-none\b/);
  assert.match(html, /\bmd:w-auto\b/);
  assert.match(html, /md:max-w-\[80%\]/);
  assert.match(QUEUE_ACTION_CLASS, /\bh-7\b/);
  assert.match(QUEUE_ACTION_CLASS, /\bmin-w-7\b/);
  assert.match(QUEUE_ACTION_CLASS, /\bbg-black\/10\b/);
  assert.match(QUEUE_ACTION_CLASS, /\bhover:bg-black\/20\b/);
  assert.match(QUEUE_ACTION_CLASS, /\btext-white\b/);
  assert.match(QUEUE_ACTION_CLASS, /\bhover:text-white\b/);
  assert.doesNotMatch(QUEUE_ACTION_CLASS, /\bon-surface\b|\bsize-9\b/);
  assert.doesNotMatch(html, /\btext-warning-strong\/85\b|\btext-ink\/45\b|\bhover:text-danger\b/);
  assert.match(QUEUE_HOURGLASS_CLASS, /\btheme-queued-message-icon\b/);
  assert.doesNotMatch(QUEUE_HOURGLASS_CLASS, /\btext-accent-strong\b/);
  assert.match(html, /width="13"[^>]*lucide-send/);
  assert.match(html, /width="15"[^>]*lucide-trash2/);
  assert.match(html, /plan\.md/);
  assert.doesNotMatch(html, /gpt-5|high|full-access/);
});

test("a single-line queued message is centered against the action buttons", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueueList, {
      items: [{ ...queuedItem, attachments: [] }],
      removing: new Set<string>(),
      steering: new Set<string>(),
      onRemove: () => {},
      onSteer: () => {},
      t: (key) => key,
    }),
  );
  assert.match(QUEUE_CONTENT_MIN_HEIGHT_CLASS, /\bmin-h-7\b/);
  assert.match(html, new RegExp(`flex min-w-0 flex-1 flex-col justify-center ${QUEUE_CONTENT_MIN_HEIGHT_CLASS}`));
  assert.match(QUEUE_ACTION_CLASS, /\bh-7\b/);
});

test("a scrollable queue ends flush against the composer fade", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueueList, {
      items: [queuedItem, { ...queuedItem, id: "third" }],
      removing: new Set<string>(),
      steering: new Set<string>(),
      onRemove: () => {},
      onSteer: () => {},
      t: (key) => key,
    }),
  );
  // The fade's own top padding is the entire gap; a margin here would leave the
  // clipped last item floating over an empty strip.
  assert.doesNotMatch(html, /<section[^>]*\bmb-\d/);
  assert.match(html, /<ol class="max-h-56 space-y-2 overflow-y-auto"/);
});

test("steer action is disabled while that queued item is being dispatched", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueueList, {
      items: [queuedItem],
      removing: new Set<string>(),
      steering: new Set([queuedItem.id]),
      onRemove: () => {},
      onSteer: () => {},
      t: (key) => key === "session.queue.steer" ? "Steer" : key,
    }),
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Steer"/);
});
