import { strict as assert } from "node:assert";
import { test } from "node:test";
import { nextHeat } from "./composerHeat";

test("heat rises with each keystroke but never exceeds 1", () => {
  let heat = 0;
  for (let i = 0; i < 500; i += 1) heat = nextHeat(heat, 5, true);
  assert.ok(heat > 0.9 && heat <= 1);
});

test("faster typing settles brighter than slower typing", () => {
  const settle = (interval: number) => {
    let heat = 0;
    for (let i = 0; i < 200; i += 1) heat = nextHeat(heat, interval, true);
    return heat;
  };
  assert.ok(settle(60) > settle(200));
});

test("heat cools to zero after typing stops", () => {
  assert.equal(nextHeat(1, 5000, false), 0);
});
