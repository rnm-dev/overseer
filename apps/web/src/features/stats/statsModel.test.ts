import assert from "node:assert/strict";
import test from "node:test";
import { analyticsRows, fmtBytes } from "./statsModel";

test("analytics breakdown rows prioritize output token consumption", () => {
  const rows = analyticsRows([
    { user: "low", outputTokens: 10, promptCount: 20 },
    { user: "high", outputTokens: 40, promptCount: 1 },
    { user: "tie", outputTokens: 10, promptCount: 30 },
  ]);

  assert.deepEqual(rows.map((row) => row.user), ["high", "tie", "low"]);
});

test("state size is formatted as a compact binary byte amount", () => {
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(1536), "1.5 KiB");
  assert.equal(fmtBytes(12 * 1024 * 1024), "12 MiB");
  assert.equal(fmtBytes(-1), "—");
});
