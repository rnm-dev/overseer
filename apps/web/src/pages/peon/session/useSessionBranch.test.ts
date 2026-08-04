import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../../api";
import { createAndNavigateSessionBranch, sessionBranchError, sessionBranchHref } from "./useSessionBranch";

const t = (key: string) => `translated:${key}`;

test("branch model requests the source session and navigates to the created session", async () => {
  const requests: Array<[string, string]> = [];
  const destinations: string[] = [];
  await createAndNavigateSessionBranch({
    base: "/workspaces/w/peons/p",
    sessionId: "source/session",
    peonId: "peon/id",
    href: (peonId, sessionId) => `/custom/${peonId}/${sessionId}`,
    request: async (base, sessionId) => {
      requests.push([base, sessionId]);
      return { id: "branch/session" };
    },
    navigate: (destination) => destinations.push(destination),
  });

  assert.deepEqual(requests, [["/workspaces/w/peons/p", "source/session"]]);
  assert.deepEqual(destinations, ["/custom/peon/id/branch/session"]);
});

test("branch model retains fallback routing and localized errors", () => {
  assert.equal(sessionBranchHref("peon/id", "branch/session", undefined), "/peons/peon%2Fid/sessions/branch%2Fsession");
  assert.equal(sessionBranchError(new ApiError(409, "BRANCH_UNAVAILABLE", "cannot branch"), t), "cannot branch");
  assert.equal(sessionBranchError(new TypeError("network"), t), "translated:session.branch.failed");
});
