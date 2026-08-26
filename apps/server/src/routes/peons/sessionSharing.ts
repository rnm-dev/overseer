import express from "express";
import {
  createSessionInvitation,
  getSessionInvitation,
  invitationErrorResponse,
  listSessionInvitations,
  listSessionParticipants,
  revokeSessionInvitation,
  revokeSessionParticipant,
  updateSessionInvitation,
} from "../../modules/sessions/index.js";
import { getIndexedSession } from "../../modules/sessions/index.js";
import { listHeartbeatPresence, type StoredPresence } from "../../modules/presence/index.js";
import type { SessionParticipantView } from "../../modules/sessions/index.js";
import { withWorkspacePeon, type WorkspacePeonContext } from "../requestContext.js";

async function isSessionManager(ctx: WorkspacePeonContext, sessionId: string, res: express.Response): Promise<boolean> {
  if (ctx.participant) {
    res.status(403).json({ error: "participant management is not allowed", code: "FORBIDDEN" });
    return false;
  }
  if (ctx.role === "owner") return true;
  const indexed = await getIndexedSession(ctx.record.peonId, sessionId);
  if (indexed?.author && indexed.author.toLowerCase() === ctx.operator.email.toLowerCase()) return true;
  res.status(403).json({ error: "session manager access required", code: "FORBIDDEN" });
  return false;
}

function inputBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

export function mergeSessionParticipantPresence(
  participants: SessionParticipantView[],
  entries: StoredPresence[],
  now = Date.now(),
): SessionParticipantView[] {
  const presence = new Map<string, { status: "online" | "away" | "offline"; lastSeenAt: number | null }>();
  for (const entry of entries) {
    if (entry.scope !== "session") continue;
    const key = entry.participantId ?? entry.userId;
    const next = {
      status: entry.expiresAt > now ? entry.active === false ? "away" as const : "online" as const : "offline" as const,
      lastSeenAt: entry.lastSeenAt ?? null,
    };
    const previous = presence.get(key);
    if (!previous || (next.lastSeenAt ?? 0) > (previous.lastSeenAt ?? 0)) presence.set(key, next);
  }
  return participants.map((participant) => ({
    ...participant,
    presence: presence.get(participant.participantId)
      ?? presence.get(participant.identity.userId ?? "")
      ?? { status: "offline" as const, lastSeenAt: null },
  }));
}

export function registerSessionSharingRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:peonId/sessions/:sid";

  router.get(`${wp}/invitations`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    res.json({ invitations: await listSessionInvitations(c.workspaceId, c.record.peonId, String(req.params.sid)) });
  }));

  router.post(`${wp}/invitations`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    const body = inputBody(req.body);
    try {
      const created = await createSessionInvitation(c.workspaceId, c.record.peonId, String(req.params.sid), c.userId, {
        displayName: body.displayName,
        accessMode: body.accessMode,
        maxTurns: body.maxTurns as number | undefined,
        maxDurationMs: body.maxDurationMs as number | undefined,
        maxTokens: body.maxTokens as number | undefined,
        expiresInMs: body.expiresInMs as number | undefined,
      });
      res.status(201).json({ invitation: created.invitation, token: created.token });
    } catch (error) {
      const failure = invitationErrorResponse(error);
      if (failure) return res.status(failure.status).json(failure.body);
      throw error;
    }
  }));

  router.get(`${wp}/invitations/:invitationId`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    const invitation = await getSessionInvitation(c.workspaceId, c.record.peonId, String(req.params.sid), String(req.params.invitationId));
    if (!invitation) return res.status(404).json({ error: "unknown invitation", code: "UNKNOWN_INVITATION" });
    res.json({ invitation });
  }));

  router.patch(`${wp}/invitations/:invitationId`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    const body = inputBody(req.body);
    try {
      const invitation = await updateSessionInvitation(c.workspaceId, c.record.peonId, String(req.params.sid), String(req.params.invitationId), {
        displayName: body.displayName,
        accessMode: body.accessMode,
        maxTurns: body.maxTurns as number | undefined,
        maxDurationMs: body.maxDurationMs as number | undefined,
        maxTokens: body.maxTokens as number | undefined,
        expiresInMs: body.expiresInMs as number | undefined,
      });
      if (!invitation) return res.status(404).json({ error: "unknown invitation", code: "UNKNOWN_INVITATION" });
      res.json({ invitation });
    } catch (error) {
      const failure = invitationErrorResponse(error);
      if (failure) return res.status(failure.status).json(failure.body);
      throw error;
    }
  }));

  router.delete(`${wp}/invitations/:invitationId`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    const ok = await revokeSessionInvitation(c.workspaceId, c.record.peonId, String(req.params.sid), String(req.params.invitationId));
    if (!ok) return res.status(404).json({ error: "unknown or already revoked invitation", code: "UNKNOWN_INVITATION" });
    res.json({ ok: true });
  }));

  router.get(`${wp}/participants`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    const participants = await listSessionParticipants(c.workspaceId, c.record.peonId, String(req.params.sid));
    const sessionPresence = listHeartbeatPresence(c.workspaceId).filter((entry) =>
      entry.peonId === c.record.peonId && entry.sessionId === String(req.params.sid));
    res.json({
      participants: mergeSessionParticipantPresence(participants, sessionPresence),
    });
  }));

  router.delete(`${wp}/participants/:participantId`, withWorkspacePeon(async (req, res, c) => {
    if (!(await isSessionManager(c, String(req.params.sid), res))) return;
    const ok = await revokeSessionParticipant(c.workspaceId, c.record.peonId, String(req.params.sid), String(req.params.participantId));
    if (!ok) return res.status(404).json({ error: "unknown, direct, or already revoked participant", code: "UNKNOWN_PARTICIPANT" });
    res.json({ ok: true });
  }));
}
