import test from "node:test";
import assert from "node:assert/strict";
import { presenceLocationForPath } from "../presence";

test("presence location follows workspace, Peon, and session routes", () => {
  assert.deepEqual(presenceLocationForPath("/"), { scope: "workspace" });
  assert.deepEqual(presenceLocationForPath("/workspaces/ws/members"), { scope: "workspace" });
  assert.deepEqual(presenceLocationForPath("/workspaces/ws/sessions"), { scope: "workspace" });
  assert.deepEqual(presenceLocationForPath("/workspaces/ws/sessions/p%2F1/s%2F1"), {
    scope: "session",
    peonId: "p/1",
    sessionId: "s/1",
  });
  assert.deepEqual(presenceLocationForPath("/peons/p-1"), { scope: "peon", peonId: "p-1" });
  assert.deepEqual(presenceLocationForPath("/peons/p-1/projects/demo"), { scope: "peon", peonId: "p-1" });
  assert.deepEqual(presenceLocationForPath("/peons/p-1/sessions/new"), { scope: "peon", peonId: "p-1" });
  assert.deepEqual(presenceLocationForPath("/peons/p-1/sessions/s%2F1"), {
    scope: "session",
    peonId: "p-1",
    sessionId: "s/1",
  });
});
