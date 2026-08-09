import assert from "node:assert/strict";
import test from "node:test";
import { socketWorkspaceForPath } from "./socketWorkspace";

const known = new Set(["ws-current", "ws-route"]);
const workspaceIdOfPeon = (peonId: string) => peonId === "peon/route" ? "ws-route" : undefined;

test("workspace routes select their workspace before route effects update current", () => {
  assert.equal(
    socketWorkspaceForPath("/workspaces/ws-route/sessions", "ws-current", known, true, workspaceIdOfPeon),
    "ws-route",
  );
});

test("Peon routes wait for inventory and then connect directly to the owning workspace", () => {
  assert.equal(
    socketWorkspaceForPath("/peons/peon%2Froute/sessions/session-1", "ws-current", known, false, workspaceIdOfPeon),
    undefined,
  );
  assert.equal(
    socketWorkspaceForPath("/peons/peon%2Froute/sessions/session-1", "ws-current", known, true, workspaceIdOfPeon),
    "ws-route",
  );
});

test("workspace-neutral routes retain the selected workspace", () => {
  assert.equal(socketWorkspaceForPath("/", "ws-current", known, true, workspaceIdOfPeon), "ws-current");
});
