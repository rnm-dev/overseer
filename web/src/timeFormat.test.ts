import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalTimestamp } from "./timeFormat";

test("timestamps omit today, name yesterday, and use a short older date", () => {
  const now = new Date(2026, 4, 25, 8, 30).getTime();
  assert.equal(formatLocalTimestamp(new Date(2026, 4, 25, 23, 15).getTime(), now, "en", "Yesterday"), "23:15");
  assert.equal(formatLocalTimestamp(new Date(2026, 4, 24, 23, 15).getTime(), now, "en", "Yesterday"), "yesterday, 23:15");
  assert.equal(formatLocalTimestamp(new Date(2026, 4, 23, 23, 15).getTime(), now, "en", "Yesterday"), "23 may, 23:15");
});

test("the Russian catalog reads the same way, and a missing timestamp renders nothing", () => {
  const now = new Date(2026, 4, 25, 8, 30).getTime();
  assert.equal(formatLocalTimestamp(new Date(2026, 4, 24, 9, 5).getTime(), now, "ru", "Вчера"), "вчера, 09:05");
  assert.equal(formatLocalTimestamp(0, now, "ru", "Вчера"), "");
  assert.equal(formatLocalTimestamp(Number.NaN, now, "en", "Yesterday"), "");
});

test("a year boundary is an older date, not the same day-of-year", () => {
  const now = new Date(2026, 0, 2, 8, 30).getTime();
  assert.equal(formatLocalTimestamp(new Date(2026, 0, 1, 23, 15).getTime(), now, "en", "Yesterday"), "yesterday, 23:15");
  assert.equal(formatLocalTimestamp(new Date(2025, 0, 2, 23, 15).getTime(), now, "en", "Yesterday"), "2 jan, 23:15");
});
