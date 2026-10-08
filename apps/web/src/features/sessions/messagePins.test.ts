import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../shared/i18n";
import { MessagePinAction } from "./messagePins";
import type { Item } from "./parsing";
function render(item: Item, pinned = false) {
  return renderToStaticMarkup(createElement(I18nProvider, { children: createElement(MessagePinAction, {
    item,
    state: { pins: pinned ? [{ eventId: "e1", event: { type: "user_message", text: "test" }, pinnedBy: "Alice", createdAt: 1 }] : [], error: "", busy: false, toggle: async () => {}, load: async () => {} },
  }) }));
}
test("only committed messages expose pin actions", () => {
  assert.equal(render({ kind: "text", key: "draft", text: "streaming" }), "");
  assert.equal(render({ kind: "tool", key: "tool", name: "Bash" }), "");
  assert.match(render({ kind: "user", key: "u", sourceEventId: "e1", text: "hello" }), /aria-pressed="false"/);
  assert.match(render({ kind: "text", key: "t", sourceEventId: "e1", text: "answer" }, true), /aria-pressed="true"/);
  assert.match(render({ kind: "participant", key: "p", sourceEventId: "e1", text: "hello", author: { kind: "user", id: "a", label: "Alice" } }), /Pin message/);
});
