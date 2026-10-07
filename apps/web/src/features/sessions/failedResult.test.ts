import assert from "node:assert/strict";
import test from "node:test";
import { flattenEvents, resultFailureReason, type Ev, type Item } from "./parsing";

const t = ((key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key) as unknown as Parameters<typeof flattenEvents>[1];

function notices(events: Ev[]): Extract<Item, { kind: "notice" }>[] {
  return flattenEvents(events, t).filter((item): item is Extract<Item, { kind: "notice" }> => item.kind === "notice");
}

test("a failure reason prefers errors[], then result, then the subtype", () => {
  assert.equal(resultFailureReason({ errors: ["a", "b"] }), "a; b");
  assert.equal(resultFailureReason({ result: "boom" }), "boom");
  assert.equal(resultFailureReason({ subtype: "error_during_execution" }), "error_during_execution");
  assert.equal(resultFailureReason({ subtype: "success" }), "");
  assert.equal(resultFailureReason({ errors: ["line one\n  line two"] }), "line one line two");
  assert.equal(resultFailureReason({ errors: ["x".repeat(400)] }).length, 300);
});

test("a failed turn becomes its own error notice that says why", () => {
  const [notice] = notices([
    { type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } },
    { type: "result", is_error: true, subtype: "error_during_execution", errors: ["API Error: 500"], duration_ms: 10_000 },
  ]);
  assert.equal(notice.tone, "error");
  assert.equal(notice.text, "API Error: 500 · 10s");

  // The previous assistant bubble keeps its own text and gains no red suffix.
  const items = flattenEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } },
    { type: "result", is_error: true, errors: ["API Error: 500"], duration_ms: 10_000 },
  ], t);
  const text = items.find((item) => item.kind === "text") as Extract<Item, { kind: "text" }>;
  assert.equal(text.resultMeta, undefined);
});

test("an announced replay is visible on the failure that caused it", () => {
  const [notice] = notices([
    { type: "result", is_error: true, errors: ["API Error: 500"], duration_ms: 1_000, retry_scheduled: 1, retry_max: 2 },
  ]);
  assert.equal(notice.text, "API Error: 500 · 1s · session.chat.turnRetrying(1,2)");
});

test("a successful result still annotates the assistant message it belongs to", () => {
  const items = flattenEvents([
    { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    { type: "result", is_error: false, subtype: "success", duration_ms: 2_000 },
  ], t);
  const text = items.find((item) => item.kind === "text") as Extract<Item, { kind: "text" }>;
  assert.deepEqual(text.resultMeta, { text: "2s" });
  assert.equal(items.some((item) => item.kind === "notice"), false);
});
