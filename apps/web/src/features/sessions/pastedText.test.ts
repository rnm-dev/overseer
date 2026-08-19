import assert from "node:assert/strict";
import test from "node:test";
import { PASTED_TEXT_MIN_CHARS, PASTED_TEXT_MIN_LINES, isLongPastedText, isPastedTextName, pastedTextFile } from "./pastedText";

test("ordinary pastes stay in the textarea", () => {
  assert.equal(isLongPastedText(""), false);
  assert.equal(isLongPastedText("fix the login redirect"), false);
  assert.equal(isLongPastedText("x".repeat(PASTED_TEXT_MIN_CHARS - 1)), false);
  assert.equal(isLongPastedText("line\n".repeat(PASTED_TEXT_MIN_LINES - 2)), false);
});

test("a dense or a tall paste becomes an attachment", () => {
  assert.equal(isLongPastedText("x".repeat(PASTED_TEXT_MIN_CHARS)), true);
  // Short lines, but far taller than the composer can show.
  assert.equal(isLongPastedText("a\n".repeat(PASTED_TEXT_MIN_LINES)), true);
});

test("pasted text is named as a text file, uniquely per attachment slot", () => {
  const file = pastedTextFile("hello", 1_700_000_000_000);
  assert.equal(file.name, "pasted-text-1700000000000.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(file.size, 5);
  // Two pastes into one message land in different slots, so their names differ
  // even when the clock does not move between them.
  assert.equal(pastedTextFile("hello", 1_700_000_000_000, 2).name, "pasted-text-1700000000000-2.txt");
});

test("the chip label only claims pastes the composer created", () => {
  assert.equal(isPastedTextName("pasted-text-1700000000000.txt"), true);
  assert.equal(isPastedTextName("pasted-text-1700000000000-2.txt"), true);
  assert.equal(isPastedTextName("pasted-text-notes.txt"), false);
  assert.equal(isPastedTextName("notes.txt"), false);
});
