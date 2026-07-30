import assert from "node:assert/strict";
import test from "node:test";
import { getOrStartAuthBootstrap } from "./authBootstrap";

test("StrictMode effect replays share one auth bootstrap request", async () => {
  const ref: { current: Promise<string> | null } = { current: null };
  let starts = 0;
  const start = async () => {
    starts += 1;
    return "operator@example.test";
  };

  const first = getOrStartAuthBootstrap(ref, start);
  const replay = getOrStartAuthBootstrap(ref, start);

  assert.equal(first, replay);
  assert.equal(starts, 1);
  assert.equal(await replay, "operator@example.test");
});
