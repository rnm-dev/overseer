import assert from "node:assert/strict";
import test from "node:test";
import { createSessionBranch, sessionLineage } from "./sessionBranch";

test("branch creation uses the encoded provider-neutral route and stable request id", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: "new-session" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await createSessionBranch("/workspaces/w/peons/p", "source/session", "branch-request"), { id: "new-session" });
    const request = requests[0]!;
    assert.equal(request?.url, "/api/workspaces/w/peons/p/sessions/source%2Fsession/branch");
    assert.equal(new Headers(request?.init?.headers).get("Peon-Request-Id"), "branch-request");
    assert.equal(request?.init?.method, "POST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("branch lineage wins over delegated parent lineage", () => {
  assert.deepEqual(sessionLineage({ branchedFromSessionId: "branch-source", parentSessionId: "parent" }), { sourceSessionId: "branch-source", relation: "branch" });
  assert.deepEqual(sessionLineage({ parentSessionId: "parent" }), { sourceSessionId: "parent", relation: "subsession" });
  assert.equal(sessionLineage({}), null);
});
