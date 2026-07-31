import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QUEUE_ACTION_CLASS, QUEUE_HOURGLASS_CLASS, QueueList } from "./peon/session/QueueList";
import type { QueueItem } from "./peon/session/queue";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const queuedItem: QueueItem = {
  id: "second",
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

test("every queued item exposes an accessible send-now action", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueueList, {
      items: [queuedItem],
      removing: new Set<string>(),
      sending: new Set<string>(),
      onRemove: () => {},
      onSendNow: () => {},
      t: (key) => key === "session.queue.sendNow" ? "Отправить сейчас" : key,
    }),
  );
  assert.match(html, /aria-label="Отправить сейчас"/);
  assert.match(html, /class="hidden sm:inline">Отправить сейчас<\/span>/);
  assert.match(html, /lucide-hourglass/);
  assert.match(html, /width="13"[^>]*lucide-hourglass/);
  assert.doesNotMatch(html, /size-8[^>]*>[\s\S]*?lucide-hourglass/);
  assert.doesNotMatch(html, /viktor@example\.test/);
  assert.match(html, /bg-warning-deep\/55/);
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
  assert.match(QUEUE_HOURGLASS_CLASS, /\btext-warning-strong\/70\b/);
  assert.doesNotMatch(QUEUE_HOURGLASS_CLASS, /\btext-accent-strong\b/);
  assert.match(html, /width="13"[^>]*lucide-send/);
  assert.match(html, /width="15"[^>]*lucide-trash2/);
  assert.match(html, /plan\.md/);
  assert.doesNotMatch(html, /gpt-5|high|full-access/);
});

test("send-now action is disabled while that queued item is being dispatched", () => {
  const html = renderToStaticMarkup(
    React.createElement(QueueList, {
      items: [queuedItem],
      removing: new Set<string>(),
      sending: new Set([queuedItem.id]),
      onRemove: () => {},
      onSendNow: () => {},
      t: (key) => key === "session.queue.sendNow" ? "Send now" : key,
    }),
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="Send now"/);
});
