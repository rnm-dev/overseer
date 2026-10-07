import assert from "node:assert/strict";
import { test } from "node:test";
import { directoryInvalidator, visibleDirectories } from "./projectDirectoryWatch";
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
test("collapsed ancestors remove descendant watches without losing remembered expansion", () => {
  assert.deepEqual(visibleDirectories(new Set(["", "src", "src/components", "other/deep"])), ["", "src", "src/components"]);
});
test("changes during slow read coalesce into one trailing read; unmount cancels it", async () => {
  const reads: Array<() => void> = [];
  const invalidate = directoryInvalidator(() => new Promise<void>((resolve) => reads.push(resolve)));
  invalidate.changed(); assert.equal(reads.length, 1);
  for (let i = 0; i < 100; i++) invalidate.changed();
  assert.equal(reads.length, 1);
  reads[0](); await flush(); assert.equal(reads.length, 2);
  invalidate.changed(); invalidate.close(); reads[1](); await flush();
  assert.equal(reads.length, 2);
});

test("a failed listing retries without another filesystem event and stops after recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const invalidate = directoryInvalidator(async () => ++reads > 1);
  invalidate.changed(); await flush(); assert.equal(reads, 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(reads, 2);
  t.mock.timers.tick(60_000); await flush(); assert.equal(reads, 2);
  invalidate.close();
});
