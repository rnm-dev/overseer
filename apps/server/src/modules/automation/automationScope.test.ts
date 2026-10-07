import assert from "node:assert/strict";
import test from "node:test";
import { automationMayUseProject } from "./automationScope.js";
import type { AutomationContext } from "./automationScope.js";

function context(scope: { projectId: string | null; projectKey: string | null }): AutomationContext {
  return {
    token: {
      id: "token-1",
      workspaceId: "ws-1",
      peonId: "peon-1",
      projectId: scope.projectId,
      projectKey: scope.projectKey,
      userId: "user-1",
      label: null,
      createdAt: 0,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    },
    record: { peonId: "peon-1", workspaceId: "ws-1" } as AutomationContext["record"],
    workspaceId: "ws-1",
    userId: "user-1",
    role: "member",
    operator: { email: "owner@example.com", githubLogin: null },
    projectKey: scope.projectKey,
    projectId: scope.projectId,
  };
}

test("a project-scoped token cannot reach a sibling project on the same Peon", async () => {
  const scoped = context({ projectId: "proj-a", projectKey: "alpha" });
  assert.equal(await automationMayUseProject(scoped, "alpha", "proj-a"), true);
  assert.equal(await automationMayUseProject(scoped, "beta", "proj-b"), false);
  // A session with no project at all is Peon-wide work, which a project-scoped
  // token has no claim on either.
  assert.equal(await automationMayUseProject(scoped, null, null), false);
});

test("a legacy project-scoped token without a project id still matches by key", async () => {
  const scoped = context({ projectId: null, projectKey: "alpha" });
  assert.equal(await automationMayUseProject(scoped, "alpha", null), true);
  assert.equal(await automationMayUseProject(scoped, "beta", null), false);
});

test("a Peon-scoped token covers unassigned sessions without consulting project ACLs", async () => {
  const peonScoped = context({ projectId: null, projectKey: null });
  assert.equal(await automationMayUseProject(peonScoped, null, null), true);
});
