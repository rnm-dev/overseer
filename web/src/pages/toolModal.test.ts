import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemView, OTHER_ATTACHMENT_CLASS, OTHER_USER_BUBBLE_AUTHOR_CLASS, OTHER_USER_BUBBLE_CLASS, OTHER_USER_BUBBLE_TIME_CLASS, OWN_ATTACHMENT_CLASS, OWN_USER_BUBBLE_CLASS, OWN_USER_BUBBLE_TIME_CLASS, attachmentMeta, editDiff, editFileName, editOperation, editStats, editStatsFromInput, formatMessageTimestamp, isCompactUserMessage, isOwnMessageAuthor } from "./peon/session/messageParts";
import { flattenEvents, toolHasOutputSection } from "./peon/session/parsing";

const t = ((key: string) => key) as Parameters<typeof ItemView>[0]["t"];

test("edit tool details omit the output section", () => {
  assert.equal(toolHasOutputSection("Edit"), false);
  assert.equal(toolHasOutputSection("edit"), false);
  assert.equal(toolHasOutputSection(" EDIT "), false);
});

test("own chat messages use deep forge while other users use the canonical surface", () => {
  assert.match(OWN_USER_BUBBLE_CLASS, /\bbg-forge-deep\b/);
  assert.match(OWN_USER_BUBBLE_CLASS, /\btext-bone\b/);
  assert.doesNotMatch(OWN_USER_BUBBLE_CLASS, /\bsurface\b/);
  assert.match(OTHER_USER_BUBBLE_CLASS, /\bsurface\b/);
  assert.doesNotMatch(OTHER_USER_BUBBLE_CLASS, /\bbg-forge-deep\b/);
  assert.match(OTHER_USER_BUBBLE_AUTHOR_CLASS, /\btext-fel-bright\b/);
  assert.match(OTHER_USER_BUBBLE_AUTHOR_CLASS, /\bfont-body\b/);
  assert.match(OWN_USER_BUBBLE_TIME_CLASS, /\btext-bone\/60\b/);
  assert.match(OTHER_USER_BUBBLE_TIME_CLASS, /\btext-bone-faint\b/);
  assert.match(OWN_USER_BUBBLE_TIME_CLASS, /\bfont-body\b/);
});

test("message ownership matches current email or GitHub login without case sensitivity", () => {
  const user = { email: "Viktor.Ten@me.com", githubLogin: "vibze" };
  assert.equal(isOwnMessageAuthor(user, "viktor.ten@me.com"), true);
  assert.equal(isOwnMessageAuthor(user, undefined, "VIBZE"), true);
  assert.equal(isOwnMessageAuthor(user, undefined, undefined, "other@example.com"), false);
  assert.equal(isOwnMessageAuthor(null, "viktor.ten@me.com"), false);
});

test("message attachments adapt to bubble ownership and expose compact metadata", () => {
  assert.match(OWN_ATTACHMENT_CLASS, /\bbg-iron-950\/25\b/);
  assert.match(OTHER_ATTACHMENT_CLASS, /\bon-surface\b/);
  assert.equal(attachmentMeta({ type: "image", name: "preview.png", size: 245_760 }), "PNG · 240 KB");
  assert.equal(attachmentMeta({ type: "file", name: "notes", size: 1_258_291 }), "FILE · 1.2 MB");
});

test("message timestamps omit today, name yesterday, and use a short older date", () => {
  const now = new Date(2026, 4, 25, 8, 30).getTime();
  assert.equal(formatMessageTimestamp(new Date(2026, 4, 25, 23, 15).getTime(), now, "en", "Yesterday"), "23:15");
  assert.equal(formatMessageTimestamp(new Date(2026, 4, 24, 23, 15).getTime(), now, "en", "Yesterday"), "yesterday, 23:15");
  assert.equal(formatMessageTimestamp(new Date(2026, 4, 23, 23, 15).getTime(), now, "en", "Yesterday"), "23 may, 23:15");
});

test("only short attachment-free single-line user messages use the compact timestamp row", () => {
  assert.equal(isCompactUserMessage("Short message"), true);
  assert.equal(isCompactUserMessage("A message that is deliberately longer than forty-eight characters"), false);
  assert.equal(isCompactUserMessage("first\nsecond"), false);
  assert.equal(isCompactUserMessage("Short", [{ type: "file", name: "plan.md" }]), false);
});

test("assistant timestamp and result summary share one Golos metadata row", () => {
  const [item] = flattenEvents([
    { type: "assistant", createdAt: Date.now(), message: { content: [{ type: "text", text: "Done" }] } },
    { type: "result", duration_ms: 3_000, num_turns: 1, usage: { output_tokens: 28 } },
  ], t);
  assert.equal(item.kind, "text");
  if (item.kind !== "text") return;
  assert.equal(item.resultMeta?.text, "3s · session.chat.turns · 28 peon.stats.outputtokens");
  const html = renderToStaticMarkup(ItemView({ item, t }));
  assert.match(html, /font-body/);
  assert.match(html, /<time[^>]*>[^<]+<\/time><span[^>]*>·<\/span><span>3s · session\.chat\.turns · 28 peon\.stats\.outputtokens<\/span>/);
});

test("other tool detail types retain their output section", () => {
  assert.equal(toolHasOutputSection("Bash"), true);
  assert.equal(toolHasOutputSection("Read"), true);
  assert.equal(toolHasOutputSection(undefined), true);
});

test("edit modal title uses the edited file name", () => {
  assert.equal(editFileName({ file_path: "/workspace/src/App.tsx" }), "App.tsx");
  assert.equal(editFileName({ filePath: "src\\components\\Dialog.tsx" }), "Dialog.tsx");
  assert.equal(editFileName({ changes: [{ path: "web/src/main.tsx" }] }), "main.tsx");
  assert.equal(editFileName({ changes: [{ path: "src/one.ts" }, { path: "src/two.ts" }] }), "one.ts (+1)");
  assert.equal(editFileName({ patch: "*** Update File: web/src/ui.tsx\n@@" }), "ui.tsx");
  assert.equal(editFileName({ old_string: "before", new_string: "after" }), null);
});

test("edit stats count added and removed lines for modal and chat labels", () => {
  assert.deepEqual(editStats([
    { kind: "context", text: "same" },
    { kind: "remove", text: "old one" },
    { kind: "remove", text: "old two" },
    { kind: "add", text: "new" },
  ]), { added: 1, removed: 2 });
  assert.equal(editStats(null), null);
  assert.deepEqual(editStatsFromInput({ changes: [{ diff: "--- a/file\n+++ b/file\n-old one\n-old two\n+new" }] }), { added: 1, removed: 2 });
  assert.deepEqual(editStatsFromInput({ old_string: "old one\nold two", new_string: "new" }), { added: 1, removed: 2 });
});

test("file changes expose create and delete operations from current and legacy Codex kinds", () => {
  assert.equal(editOperation({ changes: [{ kind: { type: "add" }, path: "new.ts", diff: "" }] }), "Create");
  assert.equal(editOperation({ changes: [{ kind: { type: "delete" }, path: "old.ts", diff: "" }] }), "Delete");
  assert.equal(editOperation({ changes: [{ kind: "add" }] }), "Create");
  assert.equal(editOperation({ changes: [{ kind: "update" }] }), "Edit");
  assert.equal(editOperation({ changes: [{ kind: "add" }, { kind: "delete" }] }), "Edit");
  assert.equal(editOperation({ patch: "*** Add File: src/new.ts\n+hello" }), "Create");
  assert.equal(editOperation({ diff: "--- a/old.ts\n+++ /dev/null\n-old" }), "Delete");
});

test("create and delete stats use real diff lines and whole-file hunk metadata", () => {
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "add" }, diff: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three" }] }), { added: 3, removed: 0 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "delete" }, diff: "--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two" }] }), { added: 0, removed: 2 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "add" }, diff: "@@ -0,0 +1,7 @@" }] }), { added: 7, removed: 0 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "delete" }, diff: "@@ -1,5 +0,0 @@" }] }), { added: 0, removed: 5 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "add" }, diff: "--- /dev/null\n+++ b/empty.ts" }] }), { added: 0, removed: 0 });
});

test("file change rows show the operation and only its relevant line count", () => {
  const created = renderToStaticMarkup(ItemView({
    item: { kind: "tool", key: "create", name: "Edit", input: { changes: [{ kind: { type: "add" }, path: "src/new.ts", diff: "@@ -0,0 +1,3 @@" }] } },
    t,
  }));
  const deleted = renderToStaticMarkup(ItemView({
    item: { kind: "tool", key: "delete", name: "Edit", input: { changes: [{ kind: { type: "delete" }, path: "src/old.ts", diff: "@@ -1,2 +0,0 @@" }] } },
    t,
  }));
  assert.match(created, />Create</);
  assert.match(created, />\+3</);
  assert.doesNotMatch(created, /−0/);
  assert.match(deleted, />Delete</);
  assert.match(deleted, />−2</);
  assert.doesNotMatch(deleted, /\+0/);
});

test("edit diff tracks old and new file line numbers across unified diff hunks", () => {
  const lines = editDiff({ changes: [{ path: "file.ts", diff: "--- a/file.ts\n+++ b/file.ts\n@@ -10,3 +10,4 @@\n same\n-old\n+new\n+extra\n tail" }] });
  assert.deepEqual(lines?.slice(3), [
    { kind: "context", text: " same", oldLine: 10, newLine: 10 },
    { kind: "remove", text: "old", oldLine: 11, newLine: undefined },
    { kind: "add", text: "new", oldLine: undefined, newLine: 11 },
    { kind: "add", text: "extra", oldLine: undefined, newLine: 12 },
    { kind: "context", text: " tail", oldLine: 12, newLine: 13 },
  ]);
});

test("old/new string edit diff numbers both sides from line one", () => {
  assert.deepEqual(editDiff({ old_string: "same\nold", new_string: "same\nnew" }), [
    { kind: "context", text: "same", oldLine: 1, newLine: 1 },
    { kind: "add", text: "new", newLine: 2 },
    { kind: "remove", text: "old", oldLine: 2 },
  ]);
});
