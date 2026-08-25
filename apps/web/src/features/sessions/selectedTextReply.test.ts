import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REPLY_SELECTED_TEXT_BYTES,
  MAX_REPLY_SELECTED_TEXT_CHARS,
  parseSelectedTextReply,
  replyIdentity,
  replyPreview,
} from "./selectedTextReply";

test("selected-text replies accept the bounded wire shape", () => {
  const reply = parseSelectedTextReply({ eventId: "event_1", selectedText: "quoted context" });
  assert.deepEqual(reply, { eventId: "event_1", selectedText: "quoted context" });
  assert.equal(replyIdentity(reply), "event_1\u0000quoted context");
});

test("selected-text replies reject malformed or oversized selections", () => {
  assert.equal(parseSelectedTextReply({ eventId: "event.1", selectedText: "text" }), null);
  assert.equal(parseSelectedTextReply({ eventId: "event_1", selectedText: "  " }), null);
  assert.equal(parseSelectedTextReply({ eventId: "event_1", selectedText: "x".repeat(MAX_REPLY_SELECTED_TEXT_CHARS + 1) }), null);
  assert.equal(parseSelectedTextReply({ eventId: "event_1", selectedText: "я".repeat(MAX_REPLY_SELECTED_TEXT_BYTES) }), null);
});

test("selected-text previews stay compact without splitting Unicode", () => {
  assert.equal(replyPreview("🙂🙂🙂", 2), "🙂🙂…");
  assert.equal(replyIdentity(null), "");
});
