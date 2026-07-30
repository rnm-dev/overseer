import assert from "node:assert/strict";
import { test } from "node:test";
import { claimCodeForPage, claimDecisionPath, claimResolveBody } from "./peonClaimModel";

test("claim code is accepted only in the frozen Crockford form", () => {
  assert.equal(claimCodeForPage("7K3M-9Q2R", null), "7K3M-9Q2R");
  assert.equal(claimCodeForPage("", "7K3M-9Q2R"), "7K3M-9Q2R");
  assert.equal(claimCodeForPage("7k3m-9q2r", null), "");
  assert.equal(claimCodeForPage("IIII-OOOO", null), "");
});

test("operator code travels in a resolve body while only non-secret IDs enter decision routes", () => {
  assert.deepEqual(claimResolveBody("7K3M-9Q2R"), {
    type: "claim_resolve",
    protocol: 1,
    operatorCode: "7K3M-9Q2R",
  });
  const path = claimDecisionPath("workspace/id", "claim/id");
  assert.equal(path, "/workspaces/workspace%2Fid/peon-claims/claim%2Fid/decision");
  assert.equal(path.includes("7K3M"), false);
});
