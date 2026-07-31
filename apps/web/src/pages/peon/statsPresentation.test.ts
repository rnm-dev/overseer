import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyticsRows } from "./statsModel.js";

test("AI statistics request and render user and project analytics", () => {
  const source = readFileSync(new URL("./PeonStats.tsx", import.meta.url), "utf8");

  assert.match(source, /analytics\?period=\$\{period\}&groupBy=user/);
  assert.match(source, /analytics\?period=\$\{period\}&groupBy=project/);
  assert.match(source, /peon\.stats\.prompts/);
  assert.match(source, /peon\.stats\.attributionNote/);
});

test("analytics breakdown rows prioritize output token consumption", () => {
  const rows = analyticsRows([
    { user: "low", outputTokens: 10, promptCount: 20 },
    { user: "high", outputTokens: 40, promptCount: 1 },
    { user: "tie", outputTokens: 10, promptCount: 30 },
  ]);

  assert.deepEqual(rows.map((row) => row.user), ["high", "tie", "low"]);
});
