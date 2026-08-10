import assert from "node:assert/strict";
import test from "node:test";
import { CatalogSnapshot, CatalogSnapshotError } from "./catalogSnapshot.js";

const limits = { maxPageItems: 2, maxItems: 3, maxPages: 2, maxBytes: 1_000 };
const page = (items: unknown[], overrides: Record<string, unknown> = {}) => ({
  epoch: "epoch", revision: 2, barrierSeq: 2, hasMore: false, nextCursor: null,
  frameBytes: 10, rawItems: items, parse: (raw: unknown) => raw as { id: string },
  identity: (item: { id: string }) => item.id, ...overrides,
});

test("catalog snapshot core shares barrier, pagination, identity and bounds", () => {
  const snapshot = new CatalogSnapshot<{ id: string }>("widget", "epoch", limits);
  assert.deepEqual(snapshot.append(page([{ id: "a" }], { hasMore: true, nextCursor: "next" })), { complete: false, nextCursor: "next" });
  assert.deepEqual(snapshot.append(page([{ id: "b" }])), { complete: true, nextCursor: null });
  assert.deepEqual(snapshot.items, [{ id: "a" }, { id: "b" }]);

  const duplicate = new CatalogSnapshot<{ id: string }>("widget", "epoch", limits);
  duplicate.append(page([{ id: "a" }], { hasMore: true, nextCursor: "next" }));
  assert.throws(() => duplicate.append(page([{ id: "a" }])), CatalogSnapshotError);
  assert.throws(() => new CatalogSnapshot<{ id: string }>("widget", "other", limits).append(page([])), /epoch mismatch/);
});
