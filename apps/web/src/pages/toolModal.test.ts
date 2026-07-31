import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemView, OTHER_ATTACHMENT_CLASS, OTHER_USER_BUBBLE_AUTHOR_CLASS, OTHER_USER_BUBBLE_CLASS, OTHER_USER_BUBBLE_TIME_CLASS, OWN_ATTACHMENT_CLASS, OWN_USER_BUBBLE_CLASS, OWN_USER_BUBBLE_TIME_CLASS, TOOL_ROW_CLASS, TOOL_ROW_LAYOUT_CLASS, attachmentMeta, editDiff, editFileName, editOperation, editStats, editStatsFromInput, isCompactUserMessage, isOwnMessageAuthor, simpleToolFileName, simpleToolKind, userMessageAvatar } from "./peon/session/messageParts";
import { flattenEvents, gapClass, gapPaddingClass, toolHasOutputSection } from "./peon/session/parsing";

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

test("a newly tailed own message falls back to the signed-in user's avatar", () => {
  const user = { email: "Viktor.Ten@me.com", githubLogin: "vibze", avatarUrl: "https://avatars.example/viktor.png" };
  assert.equal(userMessageAvatar(user, undefined, "viktor.ten@me.com"), user.avatarUrl);
  assert.equal(userMessageAvatar(user, undefined, undefined, "VIBZE"), user.avatarUrl);
  assert.equal(userMessageAvatar(user, "https://avatars.example/authoritative.png", "viktor.ten@me.com"), "https://avatars.example/authoritative.png");
  assert.equal(userMessageAvatar(user, undefined, "other@example.com"), undefined);
});

test("message attachments adapt to bubble ownership and expose compact metadata", () => {
  assert.match(OWN_ATTACHMENT_CLASS, /\bbg-iron-950\/25\b/);
  assert.match(OTHER_ATTACHMENT_CLASS, /\bon-surface\b/);
  assert.equal(attachmentMeta({ type: "image", name: "preview.png", size: 245_760 }), "PNG · 240 KB");
  assert.equal(attachmentMeta({ type: "file", name: "notes", size: 1_258_291 }), "FILE · 1.2 MB");
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

test("simple tool rows hide command text behind a human activity label", () => {
  const item = {
    kind: "tool" as const,
    key: "read",
    name: "Read",
    input: { file_path: "/workspace/confidential-contract.pdf" },
    result: { text: "contents", error: false },
  };
  const simple = renderToStaticMarkup(ItemView({ item, t, simpleTools: true }));
  const technical = renderToStaticMarkup(ItemView({ item, t }));

  assert.match(simple, /session\.chat\.activity\.read/);
  assert.match(simple, /session\.chat\.activity\.showTechnical/);
  assert.match(simple, /confidential-contract\.pdf/);
  assert.match(simple, /data-tool-kind="read"/);
  assert.doesNotMatch(simple, /\/workspace\//);
  assert.match(technical, /confidential-contract/);
});

test("both modes are the same row: one class list, differing only in words", () => {
  const item = {
    kind: "tool" as const,
    key: "edit",
    name: "Edit",
    input: { file_path: "/workspace/src/app.ts", old_string: "a", new_string: "b" },
    result: { text: "ok", error: false },
  };
  const simple = renderToStaticMarkup(ItemView({ item, t, simpleTools: true }));
  const technical = renderToStaticMarkup(ItemView({ item, t }));

  const rowClass = (html: string) => /class="([^"]*)"/.exec(html.slice(html.indexOf("<button")))?.[1];
  assert.equal(rowClass(simple), rowClass(technical));
  assert.ok(rowClass(technical)?.includes(TOOL_ROW_CLASS));
  // The technical row names its operation beside the icon; the simple one does not.
  assert.match(technical, /Edit/);
  assert.doesNotMatch(simple, /Edit</);
});

test("simple tool rows expose pending and failed states without command text", () => {
  const pending = renderToStaticMarkup(ItemView({
    item: { kind: "tool", key: "pending", name: "Bash", input: { command: "secret-command" } },
    t,
    simpleTools: true,
  }));
  const failed = renderToStaticMarkup(ItemView({
    item: { kind: "tool", key: "failed", name: "Bash", input: { command: "secret-command" }, result: { text: "nope", error: true } },
    t,
    simpleTools: true,
  }));

  assert.match(pending, /session\.chat\.activity\.running/);
  assert.match(failed, /session\.chat\.activity\.failedShort/);
  assert.doesNotMatch(pending, /secret-command/);
  assert.doesNotMatch(failed, /secret-command/);
});

test("simple tool rows choose semantic icons and expose only safe file names", () => {
  assert.equal(simpleToolKind("Read"), "read");
  assert.equal(simpleToolKind("Grep"), "search");
  assert.equal(simpleToolKind("WebSearch"), "web");
  assert.equal(simpleToolKind("Edit"), "edit");
  assert.equal(simpleToolKind("Task"), "analysis");
  assert.equal(simpleToolKind("Bash"), "command");
  assert.equal(simpleToolKind("custom"), "generic");

  assert.equal(simpleToolFileName("Read", { file_path: "/private/contracts/nda.pdf" }), "nda.pdf");
  assert.equal(simpleToolFileName("NotebookEdit", { notebook_path: "analysis/risk.ipynb" }), "risk.ipynb");
  assert.equal(simpleToolFileName("Bash", { path: "/private/contracts/nda.pdf" }), null);
});

test("tool rows align to the transcript edge with a fixed icon grid", () => {
  assert.match(TOOL_ROW_CLASS, /\bgrid\b/);
  assert.match(TOOL_ROW_CLASS, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.doesNotMatch(TOOL_ROW_CLASS, /\bpx-/);
});

test("technical and simple system rows share the same compact vertical rhythm", () => {
  assert.equal(gapPaddingClass(false, false), "pt-0.5");
  assert.equal(gapClass(false, false), "mt-0.5");
  assert.equal(gapPaddingClass(true, false), "pt-6");
  assert.ok(TOOL_ROW_CLASS.startsWith(TOOL_ROW_LAYOUT_CLASS));
  assert.match(TOOL_ROW_LAYOUT_CLASS, /\bgap-x-1\.5\b/);
  assert.match(TOOL_ROW_CLASS, /\bpy-0\.5\b/);
});

test("assistant text keeps breathing room around compact system rows", () => {
  assert.equal(gapPaddingClass(false, false, true), "pt-4");
  assert.equal(gapClass(false, false, true), "mt-4");
  assert.equal(gapPaddingClass(true, false, true), "pt-6");
  assert.equal(gapPaddingClass(false, true, true), "pt-6");
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
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "add" }, diff: "" }] }), { added: 0, removed: 0 });
});

test("current Codex raw file contents produce exact create and delete line counts", () => {
  const contents = "import { NextRequest } from \"next/server\";\n\nexport async function POST() {\n  return new Response();\n}\n";
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "add" }, diff: contents }] }), { added: 5, removed: 0 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "delete" }, diff: contents }] }), { added: 0, removed: 5 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: { type: "add" }, diff: "+literal first line\n-literal second line" }] }), { added: 2, removed: 0 });
  assert.deepEqual(editStatsFromInput({ changes: [{ kind: "add", diff: "*** Add File: new.ts\n+one\n+two" }] }), { added: 2, removed: 0 });
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
