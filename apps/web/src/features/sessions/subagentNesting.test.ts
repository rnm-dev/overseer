import assert from "node:assert/strict";
import test from "node:test";
import { flattenEvents, type Ev, type Item } from "./parsing";

const t = ((key: string) => key) as unknown as Parameters<typeof flattenEvents>[1];
type Tool = Extract<Item, { kind: "tool" }>;

const agentCall = (id: string, prompt: string): Ev => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Agent", input: { description: prompt, prompt } }] },
});
const bash = (id: string, command: string, parent?: string): Ev => ({
  type: "assistant",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
const result = (id: string, text: string, parent?: string): Ev => ({
  type: "user",
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] },
});

test("parallel subagents keep their own steps under their own Agent row", () => {
  const items = flattenEvents([
    agentCall("a", "review docs"),
    agentCall("b", "review code"),
    { type: "user", parent_tool_use_id: "a", message: { content: [{ type: "text", text: "review docs" }] } },
    bash("a1", "wc -l docs", "a"),
    bash("b1", "ls app", "b"),
    result("a1", "120 docs", "a"),
    result("b1", "models", "b"),
    { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "text", text: "docs look fine" }] } },
    result("a", "report A"),
    bash("top", "git status"),
  ], t);

  assert.deepEqual(items.map((item) => item.kind === "tool" ? item.name : item.kind), ["Agent", "Agent", "Bash"]);
  const [a, b] = items as Tool[];
  assert.deepEqual(a.result, { text: "report A", error: false });
  assert.deepEqual(a.children?.map((child) => child.kind), ["tool", "text"]);
  assert.deepEqual((a.children?.[0] as Tool).result, { text: "120 docs", error: false });
  assert.equal(b.result, undefined);
  assert.deepEqual(b.children?.map((child) => (child as Tool).input), [{ command: "ls app" }]);
  assert.deepEqual((b.children?.[0] as Tool).result, { text: "models", error: false });
});

test("an unknown parent stays top level and older events stay flat", () => {
  const items = flattenEvents([bash("x1", "pwd", "missing-agent"), bash("x2", "ls")], t);
  assert.deepEqual(items.map((item) => (item as Tool).input), [{ command: "pwd" }, { command: "ls" }]);
  assert.ok(items.every((item) => !(item as Tool).children));
});
