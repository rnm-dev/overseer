import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueList } from "./QueueList";
import type { QueueItem } from "./queue";

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
  assert.match(html, /@viktor@example\.test/);
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
