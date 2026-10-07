import express from "express";
import { canAccessProject, canManageProject } from "../../modules/access/index.js";
import { getIndexedProject } from "../../modules/projects/index.js";
import {
  getAutomationToken,
  issueAutomationToken,
  listAutomationTokens,
  normalizeTokenLabel,
  resolveExpiry,
  revokeAutomationToken,
} from "../../modules/automation/index.js";
import { withWorkspacePeon } from "../requestContext.js";

// Minting and revoking live on the operator surface only. A leaked automation
// token must not be able to grow itself a longer-lived sibling, so the
// automation API deliberately cannot reach any of these routes.
export function registerAutomationTokenRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:id";
  const path = `${wp}/projects/:key/automation-tokens`;

  const withProjectScope = (handler: (
    req: express.Request,
    res: express.Response,
    c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2] & { projectKey: string; projectId: string | null; manages: boolean },
  ) => unknown) => withWorkspacePeon(async (req, res, c) => {
    const projectKey = String(req.params.key);
    const indexed = await getIndexedProject(c.record.peonId, projectKey);
    const projectId = indexed?.projectId ?? null;
    if (!(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    const manages = await canManageProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId);
    return handler(req, res, { ...c, projectKey, projectId, manages });
  });

  // A project administrator sees every token aimed at the project, because
  // that is the list they are responsible for. Everyone else sees their own —
  // a member's token carries their access, so it is theirs to audit.
  router.get(path, withProjectScope(async (_req, res, c) => {
    const tokens = await listAutomationTokens({
      workspaceId: c.workspaceId,
      peonId: c.record.peonId,
      projectId: c.projectId,
      projectKey: c.projectKey,
      ...(c.manages ? {} : { ownerUserId: c.userId }),
    });
    res.json({
      tokens: c.manages ? tokens.map((token) => ({ ...token, mine: token.ownerUserId === c.userId })) : tokens,
      canManageAll: c.manages,
    });
  }));

  // The secret is returned exactly once. There is no route that can show it
  // again, and no column that could.
  router.post(path, withProjectScope(async (req, res, c) => {
    const label = normalizeTokenLabel(req.body?.label);
    const expiresAt = resolveExpiry(req.body?.expiresInDays);
    if (expiresAt === "invalid") {
      return res.status(400).json({ error: "expiresInDays must be an integer between 1 and 365, or omitted for no expiry", code: "BAD_REQUEST" });
    }
    const { token, record } = await issueAutomationToken({
      workspaceId: c.workspaceId,
      peonId: c.record.peonId,
      projectId: c.projectId,
      projectKey: c.projectKey,
      userId: c.userId,
      label,
      expiresAt,
    });
    res.status(201).json({
      token,
      created: {
        id: record.id,
        label: record.label,
        peonId: record.peonId,
        projectKey: record.projectKey,
        projectId: record.projectId,
        ownerUserId: record.userId,
        ownerEmail: c.operator.email,
        createdAt: record.createdAt,
        lastUsedAt: null,
        expiresAt: record.expiresAt,
        mine: true,
      },
    });
  }));

  router.delete(`${path}/:tokenId`, withProjectScope(async (req, res, c) => {
    const token = await getAutomationToken(String(req.params.tokenId));
    const belongsHere = token
      && token.workspaceId === c.workspaceId
      && token.peonId === c.record.peonId
      && (c.projectId ? token.projectId === c.projectId : token.projectKey === c.projectKey);
    if (!token || !belongsHere || token.revokedAt !== null) {
      return res.status(404).json({ error: "unknown automation token", code: "UNKNOWN_TOKEN" });
    }
    if (token.userId !== c.userId && !c.manages) {
      return res.status(404).json({ error: "unknown automation token", code: "UNKNOWN_TOKEN" });
    }
    await revokeAutomationToken(token.id);
    res.json({ ok: true });
  }));
}
