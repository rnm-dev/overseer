import assert from "node:assert/strict";
import test from "node:test";
import { analyticsQuery } from "./routes/peons/runtimeReverseRead.js";

test("analytics reverse queries accept only bounded scalar and string-array filters", () => {
  assert.deepEqual(analyticsQuery({
    period: "week",
    groupBy: ["project", "model"],
  }), {
    period: "week",
    groupBy: ["project", "model"],
  });
  assert.equal(analyticsQuery({ nested: { secret: "value" } }), null);
  assert.equal(analyticsQuery(Object.fromEntries(
    Array.from({ length: 25 }, (_, index) => [`filter${index}`, "x"]),
  )), null);
});
