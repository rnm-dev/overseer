import assert from "node:assert/strict";
import test from "node:test";
import acceptance from "../fixtures/resource-sync-acceptance-v1.json" with { type: "json" };
import { ResourceProjectionHarness, ResourceProjectionHarnessError } from "../src/resourceProjectionLifecycle.js";

test("all catalog-like families execute one authority-neutral convergence state machine", () => {
  for (const family of acceptance.families) {
    const harness = new ResourceProjectionHarness({ family: family.name, authority: family.authority });
    const generation = harness.connect();
    assert.equal(harness.replace([{ identity: "one", version: 2 }], 2, generation), true);
    assert.equal(harness.apply({ identity: "one", version: 1, cursor: 3 }), true);
    assert.equal(harness.rows.get("one").version, 2);
    assert.equal(harness.apply({ identity: "two", version: 3, cursor: 4 }), true);
    harness.restart("overseer");
    assert.equal(harness.apply({ identity: "late", version: 4, cursor: 5 }, generation), false);
    assert.equal(harness.state().freshness, "stale");
  }
});

test("shared resource core fails closed on gaps, corrupt snapshots, pressure and pre-commit crashes", () => {
  const harness = new ResourceProjectionHarness({ family: "session", authority: "peon", maxItems: 1 });
  harness.connect();
  assert.throws(() => harness.replace([{ identity: "a", version: 1 }, { identity: "b", version: 1 }], 1), ResourceProjectionHarnessError);
  harness.replace([{ identity: "a", version: 1 }], 1);
  assert.equal(harness.apply({ identity: "b", version: 2, cursor: 2 }, undefined, { crashBeforeCommit: true }), false);
  assert.equal(harness.state().cursor, 1);
  assert.throws(() => harness.apply({ identity: "b", version: 2, cursor: 3 }), /cursor gap/);
});
