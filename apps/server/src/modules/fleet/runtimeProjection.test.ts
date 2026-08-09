import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseDurableRuntimeState } from "./runtimeProjection.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function frame(state: Record<string, unknown>) {
  return {
    capability: "runtime-state-v1",
    epoch: "delivery-epoch",
    cursor: "1",
    messageId: "2ec04158-4c21-47c7-a512-785de6285128",
    payload: {
      type: "runtime_state",
      protocol: 1,
      epoch: "runtime-epoch",
      revision: 1,
      generatedAt: 1,
      digest: createHash("sha256").update(canonical(state)).digest("hex"),
      state,
    },
  };
}

test("runtime projection accepts a bounded canonical state", () => {
  const parsed = parseDurableRuntimeState(frame({
    paused: false,
    capacity: { active: 0, total: 1 },
    daemon: { version: "1.2.3", revision: null },
    providers: [],
    models: [],
  }));
  assert.equal(parsed.revision, 1);
  assert.match(parsed.digest, /^[0-9a-f]{64}$/);
});

test("runtime projection rejects digest substitution and forbidden state", () => {
  const changed = frame({ paused: false });
  (changed.payload.state as { paused: boolean }).paused = true;
  assert.throws(() => parseDurableRuntimeState(changed), /digest mismatch/);
  assert.throws(
    () => parseDurableRuntimeState(frame({ providers: [{ nested: { credentials: "secret" } }] })),
    /forbidden field/,
  );
  assert.throws(
    () => parseDurableRuntimeState(frame({ providers: [{ nested: { token: "secret" } }] })),
    /forbidden field/,
  );
});

test("runtime projection rejects unknown envelope fields and oversized state", () => {
  assert.throws(
    () => parseDurableRuntimeState({ ...frame({ paused: false }), payload: { ...frame({ paused: false }).payload, extra: true } }),
    /invalid runtime state/,
  );
  assert.throws(
    () => parseDurableRuntimeState(frame({ models: "x".repeat(56 * 1024) })),
    /invalid runtime state/,
  );
  assert.throws(
    () => parseDurableRuntimeState(frame({ unexpected: true })),
    /invalid runtime state/,
  );
});
