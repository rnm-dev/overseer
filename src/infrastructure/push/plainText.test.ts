import assert from "node:assert/strict";
import { test } from "node:test";
import { plainText } from "./plainText.js";

// Two failure directions matter here: syntax that survives onto a lock screen,
// and prose that gets mangled because it merely resembles syntax. The second
// set is the reason this is a flattener rather than a Markdown parser.

test("emphasis, headings, quotes and list markers are dropped", () => {
  assert.equal(plainText("**Shipped** the _deploy_"), "Shipped the deploy");
  assert.equal(plainText("## Summary\nAll green"), "Summary All green");
  assert.equal(plainText("> quoted line"), "quoted line");
  assert.equal(plainText("- first\n- second"), "first second");
  assert.equal(plainText("1. first\n2. second"), "first second");
  assert.equal(plainText("~~dropped~~ kept"), "dropped kept");
});

test("links and images keep their text, not their URLs", () => {
  assert.equal(plainText("see [the run](https://overseer.rnm.dev/x) now"), "see the run now");
  assert.equal(plainText("![a chart](chart.png)"), "a chart");
});

test("code keeps its content and loses its fences", () => {
  assert.equal(plainText("run `npm test` first"), "run npm test first");
  assert.equal(plainText("```ts\nconst x = 1;\n```"), "const x = 1;");
});

// The session index stores previews already collapsed to one line, so the
// document structure arrives inline rather than at a line start.
test("a heading marker is dropped mid-sentence too, but an issue number is not", () => {
  assert.equal(plainText("Готово. Все проверки зелёные. ## Архитектура Плагин"), "Готово. Все проверки зелёные. Архитектура Плагин");
  assert.equal(plainText("fixed in #123"), "fixed in #123");
});

test("prose that only looks like syntax is left alone", () => {
  assert.equal(plainText("renamed session_attention to push_outbox"), "renamed session_attention to push_outbox");
  assert.equal(plainText("3 * 4 * 5 is 60"), "3 * 4 * 5 is 60");
  assert.equal(plainText("2 < 3 and 5 > 4"), "2 < 3 and 5 > 4");
  assert.equal(plainText("a_b_c stays"), "a_b_c stays");
});

test("newlines collapse into one line", () => {
  assert.equal(plainText("first line\n\n  second   line \n"), "first line second line");
});
