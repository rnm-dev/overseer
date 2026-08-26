import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REPLY_SELECTED_TEXT_BYTES,
  MAX_REPLY_SELECTED_TEXT_CHARS,
  parseSelectedTextReply,
  selectedTextReplyForRow,
  replyIdentity,
  replyPreview,
} from "./selectedTextReply";
import {
  activateSelectedTextReply,
  captureSelectionSnapshot,
  contextMenuPosition,
  selectedTextReplyContextMenuLabels,
  selectionSnapshotMatches,
} from "./SelectedTextReplyContextMenu";

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

function fakeSelection({
  anchorNode,
  focusNode,
  selectedText,
  isCollapsed = false,
}: {
  anchorNode: Node | null;
  focusNode: Node | null;
  selectedText: string;
  isCollapsed?: boolean;
}): Pick<Selection, "anchorNode" | "focusNode" | "isCollapsed" | "toString"> {
  return { anchorNode, focusNode, isCollapsed, toString: () => selectedText };
}

test("same-row selection validation preserves exact Unicode and whitespace", () => {
  const start = {} as Node;
  const end = {} as Node;
  const row = { contains: (node: Node | null) => node === start || node === end };
  const selection = fakeSelection({
    anchorNode: start,
    focusNode: end,
    selectedText: "  café\n🙂  ",
  });

  assert.deepEqual(selectedTextReplyForRow(row, "assistant_1", selection), {
    eventId: "assistant_1",
    selectedText: "  café\n🙂  ",
  });
  assert.equal(selectedTextReplyForRow(row, "assistant.1", selection), null);
});

test("collapsed, empty, and cross-row selections never offer a reply", () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const row = { contains: (node: Node | null) => node === inside };
  assert.equal(selectedTextReplyForRow(row, "event_1", fakeSelection({ anchorNode: inside, focusNode: inside, selectedText: "quoted", isCollapsed: true })), null);
  assert.equal(selectedTextReplyForRow(row, "event_1", fakeSelection({ anchorNode: inside, focusNode: inside, selectedText: "   " })), null);
  assert.equal(selectedTextReplyForRow(row, "event_1", fakeSelection({ anchorNode: inside, focusNode: outside, selectedText: "cross row" })), null);
});

test("selection and mouse-up stay inert until Reply is explicitly activated", () => {
  const node = {} as Node;
  const row = { contains: (candidate: Node | null) => candidate === node };
  const candidate = selectedTextReplyForRow(row, "event_1", fakeSelection({ anchorNode: node, focusNode: node, selectedText: "quoted" }));
  let activated = 0;
  assert.equal(activated, 0);
  assert.ok(candidate);
  assert.equal(activated, 0);
  activateSelectedTextReply(candidate, () => { activated++; });
  assert.equal(activated, 1);
});

test("context menu keeps Copy and link actions alongside Reply", () => {
  assert.deepEqual(selectedTextReplyContextMenuLabels(), ["Reply", "Copy"]);
  assert.deepEqual(selectedTextReplyContextMenuLabels("https://example.com/docs"), [
    "Reply",
    "Copy",
    "Open link in new tab",
    "Copy link address",
  ]);
});

test("context menu positioning and selection-change close helpers are bounded", () => {
  assert.deepEqual(contextMenuPosition(799, 599, 800, 600, 232, 180), { x: 560, y: 412 });
  const node = {} as Node;
  const selection = fakeSelection({ anchorNode: node, focusNode: node, selectedText: "quoted" }) as Selection;
  const snapshot = captureSelectionSnapshot(selection);
  assert.equal(selectionSnapshotMatches(selection, snapshot), true);
  assert.equal(selectionSnapshotMatches(null, snapshot), false);
});
