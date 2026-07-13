import express from "express";
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  listInvites,
  listMembers,
  listWorkspacesForUser,
  removeMember,
  revokeInvite,
  type Role,
} from "../workspaces.js";
import { ownerOnly, userOf, withWorkspace } from "./helpers.js";

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
      const role: Role = req.body?.role === "owner" ? "owner" : "member";
      res.status(201).json({ invite: await createInvite(ctx.workspaceId, role, ctx.userId) });
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
