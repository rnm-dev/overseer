import express from "express";
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  listInvites,
  listMembers,
  listWorkspacesForUser,
  membership,
  removeMember,
  revokeInvite,
  updateMemberRole,
  type Role,
} from "../workspaces.js";
import { ownerOnly, userOf, withWorkspace } from "./helpers.js";
import { canAccessPeon, canAccessProject, listMemberAccess, replaceMemberAccess, type MemberAccess } from "../access.js";
import { registry } from "../registry.js";
import { getIndexedSession } from "../sessionIndex.js";
import { heartbeatPresence, listVisiblePresence, removePresence } from "../modules/presence/index.js";

// Workspaces (multi-tenant ACL) — mounted on /api AFTER operatorAuth. Routes
// under /workspaces/:wsId require membership (the ACL gate via withWorkspace).
export function workspacesRouter(): express.Router {
  const router = express.Router();

  router.get("/workspaces", async (req, res) => {
    res.json({ workspaces: await listWorkspacesForUser(userOf(req).userId) });
  });

  router.post("/workspaces", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "name is required", code: "BAD_REQUEST" });
    res.status(201).json({ workspace: await createWorkspace(name, userOf(req).userId) });
  });

  // Members
  router.get("/workspaces/:wsId/members", withWorkspace(async (_req, res, ctx) => res.json({ members: await listMembers(ctx.workspaceId) })));
  router.get("/workspaces/:wsId/presence", withWorkspace(async (_req, res, ctx) => {
    res.json({ presence: await visiblePresenceFor(ctx.workspaceId, ctx.userId, ctx.role) });
  }));
  router.post("/workspaces/:wsId/presence", withWorkspace(async (req, res, ctx) => {
    const connectionId = typeof req.body?.connectionId === "string" ? req.body.connectionId : "";
    const scope = req.body?.scope;
    if (!connectionId || connectionId.length > 100 || !["workspace", "peon", "session"].includes(scope)) {
      return res.status(400).json({ error: "invalid presence heartbeat", code: "BAD_REQUEST" });
    }
    const peonId = scope === "workspace" ? null : String(req.body?.peonId ?? "");
    const record = peonId ? await registry.get(peonId) : null;
    if (peonId && (!record || record.workspaceId !== ctx.workspaceId || !(await canAccessPeon(ctx.workspaceId, ctx.userId, ctx.role, peonId)))) {
      return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
    }
    const sessionId = scope === "session" ? String(req.body?.sessionId ?? "") : null;
    const session = scope === "session" && peonId && sessionId ? await getIndexedSession(peonId, sessionId) : null;
    if (scope === "session" && (!session || (session.projectKey && !(await canAccessProject(ctx.workspaceId, ctx.userId, ctx.role, peonId!, session.projectKey, session.projectId))))) {
      return res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
    }
    heartbeatPresence({
      connectionId,
      workspaceId: ctx.workspaceId,
      userId: req.user!.userId,
      email: req.user!.email,
      githubLogin: req.user!.githubLogin,
      avatarUrl: req.user!.avatarUrl,
      scope,
      peonId,
      sessionId,
      projectKey: session?.projectKey ?? null,
      projectId: session?.projectId ?? null,
    });
    res.json({ presence: await visiblePresenceFor(ctx.workspaceId, ctx.userId, ctx.role) });
  }));
  router.delete("/workspaces/:wsId/presence", withWorkspace(async (req, res, ctx) => {
    const connectionId = typeof req.body?.connectionId === "string" ? req.body.connectionId : "";
    if (connectionId) removePresence(ctx.workspaceId, ctx.userId, connectionId);
    res.status(204).end();
  }));
  router.delete(
    "/workspaces/:wsId/members/:userId",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const result = await removeMember(ctx.workspaceId, String(req.params.userId));
      if (result === "not_found") return res.status(404).json({ error: "not a member", code: "UNKNOWN_MEMBER" });
      if (result === "owner") return res.status(409).json({ error: "workspace owners cannot be removed", code: "CANNOT_REMOVE_OWNER" });
      res.json({ ok: true });
    }),
  );
  router.patch(
    "/workspaces/:wsId/members/:userId",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      if (req.body?.role !== "owner" && req.body?.role !== "member") return res.status(400).json({ error: "role must be owner or member", code: "BAD_REQUEST" });
      const role: Role = req.body.role;
      const result = await updateMemberRole(ctx.workspaceId, String(req.params.userId), role);
      if (result === "not_found") return res.status(404).json({ error: "not a member", code: "UNKNOWN_MEMBER" });
      if (result === "last_owner") return res.status(409).json({ error: "assign another owner before changing this role", code: "LAST_OWNER" });
      res.json({ ok: true, role });
    }),
  );
  router.get(
    "/workspaces/:wsId/members/:userId/access",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const userId = String(req.params.userId);
      const memberRole = await membership(ctx.workspaceId, userId);
      if (!memberRole) return res.status(404).json({ error: "not a member", code: "UNKNOWN_MEMBER" });
      res.json({ access: await listMemberAccess(ctx.workspaceId, userId), unrestricted: memberRole === "owner" });
    }),
  );
  router.put(
    "/workspaces/:wsId/members/:userId/access",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const userId = String(req.params.userId);
      const memberRole = await membership(ctx.workspaceId, userId);
      if (!memberRole) return res.status(404).json({ error: "not a member", code: "UNKNOWN_MEMBER" });
      if (memberRole === "owner") return res.status(409).json({ error: "owners always have full access", code: "OWNER_UNRESTRICTED" });
      const peonIds: string[] = Array.isArray(req.body?.peonIds) ? (req.body.peonIds as unknown[]).filter((value): value is string => typeof value === "string" && !!value) : [];
      const projects: { peonId: string; projectKey: string; projectId?: string | null }[] = Array.isArray(req.body?.projects)
        ? (req.body.projects as unknown[]).filter((value): value is { peonId: string; projectKey: string; projectId?: string | null } => {
            if (!value || typeof value !== "object") return false;
            const item = value as { peonId?: unknown; projectKey?: unknown; projectId?: unknown };
            return typeof item.peonId === "string" && !!item.peonId && typeof item.projectKey === "string" && !!item.projectKey
              && (item.projectId === undefined || item.projectId === null || typeof item.projectId === "string");
          })
        : [];
      const workspacePeons = new Set((await registry.list(ctx.workspaceId)).map((record) => record.peonId));
      const access: MemberAccess = {
        peonIds: [...new Set(peonIds)].filter((id) => workspacePeons.has(id)),
        projects: projects.filter((item) => workspacePeons.has(item.peonId)),
      };
      await replaceMemberAccess(ctx.workspaceId, userId, access, ctx.userId);
      res.json({ access });
    }),
  );

  // Invite links — owner-only (they carry a join capability). People join by
  // opening the link, which posts to /invites/:token/accept below.
  router.get(
    "/workspaces/:wsId/invites",
    withWorkspace(async (_req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      res.json({ invites: await listInvites(ctx.workspaceId) });
    }),
  );
  router.post(
    "/workspaces/:wsId/invites",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      if (req.body?.role !== "owner" && req.body?.role !== "member") return res.status(400).json({ error: "role must be owner or member", code: "BAD_REQUEST" });
      const role: Role = req.body.role;
      const inviteeLabel = typeof req.body?.inviteeLabel === "string" ? req.body.inviteeLabel.trim() : "";
      // Display-only organizer label. The private token is the capability; do
      // not compare this value with the email returned by GitHub OAuth.
      if (!inviteeLabel) return res.status(400).json({ error: "member label is required", code: "BAD_REQUEST" });
      res.status(201).json({ invite: await createInvite(ctx.workspaceId, role, ctx.userId, inviteeLabel) });
    }),
  );
  router.delete(
    "/workspaces/:wsId/invites/:id",
    withWorkspace(async (req, res, ctx) => {
      if (!ownerOnly(res, ctx.role)) return;
      const ok = await revokeInvite(ctx.workspaceId, String(req.params.id));
      if (!ok) return res.status(404).json({ error: "unknown invite", code: "UNKNOWN_INVITE" });
      res.json({ ok: true });
    }),
  );

  // Accept an invite (authenticated) — the /join page posts here after sign-in.
  router.post("/invites/:token/accept", async (req, res) => {
    const result = await acceptInvite(String(req.params.token), userOf(req).userId);
    if (!result.ok) return res.status(404).json({ error: "invalid or expired invite", code: "INVALID_INVITE" });
    res.json({ workspace: result.workspace, alreadyMember: result.alreadyMember });
  });

  return router;
}

function visiblePresenceFor(workspaceId: string, userId: string, role: Role) {
  return listVisiblePresence(
    workspaceId,
    (peonId) => canAccessPeon(workspaceId, userId, role, peonId),
    (peonId, projectKey, projectId) => canAccessProject(workspaceId, userId, role, peonId, projectKey, projectId),
  );
}
