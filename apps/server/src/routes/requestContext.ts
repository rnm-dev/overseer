import { isIP } from "node:net";
import express from "express";
import { registry, type PeonRecord } from "../modules/fleet/index.js";
import { membership, type Role } from "../modules/workspaces/index.js";
import {
  requestHasTrustedOrigin,
  requiresCsrfOrigin,
  type AuthContext,
  verifyDeviceToken,
  webSessionToken,
} from "../modules/auth/index.js";
import { resolveCredential } from "../modules/fleet/index.js";
import { canAccessIndexedSessionNow, canAccessPeon } from "../modules/access/index.js";
import {
  authorizeSessionParticipantRequest,
  ensureDirectSessionParticipant,
  getSessionParticipantByCredential,
  getSessionParticipantForUser,
  participantSessionIdForRequest,
  participantScopedPath,
  sessionParticipantToken,
} from "../modules/sessions/index.js";
import type { SessionParticipantAuth } from "../modules/sessions/index.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthContext; // set by operatorAuth
      authTransport?: "bearer" | "cookie" | "participant"; // set by operatorAuth
      peonCred?: { id: string; workspaceId: string; boundPeonId: string | null }; // set by credentialAuth
      sessionParticipant?: SessionParticipantAuth; // set by the scoped session credential
      sessionParticipantCommandId?: string | null;
    }
  }
}

export function bearer(req: express.Request): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

// Observed source address of a register call. Strip the
// IPv4-mapped-IPv6 prefix Node reports for v4 clients so we store a clean
// dotted-quad. We never trust a Peon's self-claimed source address.
export function sourceAddress(req: express.Request): string {
  const raw = req.socket.remoteAddress ?? "";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

// Client identity for security attribution and IP-scoped abuse limits.
// req.ip consults X-Forwarded-For only through the validated proxy ranges set
// on the Express app. CF-Connecting-IP is deliberately not read here: nginx
// accepts it only from Cloudflare networks, then overwrites X-Forwarded-For
// with one canonical address. Direct callers therefore cannot select this IP.
export function clientInfo(req: express.Request): { ip: string | null; userAgent: string | null } {
  const forwarded = req.ip;
  // proxy-addr stops at malformed XFF entries but returns that entry as req.ip.
  // Never turn arbitrary strings into independent rate-limit identities.
  const ip = (forwarded && isIP(forwarded) ? forwarded.replace(/^::ffff:/, "") : sourceAddress(req)) || null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  return { ip, userAgent: ua };
}

// North-bound auth: the peon's own recruitment credential (credentials.ts); it
// also tells us which workspace the peon belongs to.
export const credentialAuth: express.RequestHandler = (req, res, next) => {
  void (async () => {
    const cred = await resolveCredential(bearer(req));
    if (!cred) return res.status(401).json({ error: "invalid or revoked peon credential", code: "UNAUTHENTICATED" });
    req.peonCred = {
      id: cred.id,
      workspaceId: cred.workspaceId,
      boundPeonId: cred.boundPeonId,
    };
    next();
  })().catch(next);
};

// South-facing operator auth guard: a device token → AuthContext on req.user.
export const operatorAuth: express.RequestHandler = (req, res, next) => {
  void (async () => {
    const bearerToken = bearer(req);
    const transport = bearerToken ? "bearer" : "cookie";
    const auth = await verifyDeviceToken(bearerToken || webSessionToken(req));
    if (auth) {
      if (transport === "cookie" && requiresCsrfOrigin(req.method) && !requestHasTrustedOrigin(req)) {
        return res.status(403).json({ error: "trusted request origin required", code: "CSRF_ORIGIN" });
      }
      req.user = auth;
      req.authTransport = transport;
      return next();
    }
    // A participant credential is accepted only on the canonical session/file
    // paths. It cannot become a general-purpose operator session by being
    // copied into another API request.
    const participantToken = sessionParticipantToken(req);
    if (!participantToken || !participantScopedPath(req.path)) {
      return res.status(401).json({ error: "authentication required", code: "UNAUTHENTICATED" });
    }
    const participant = await getSessionParticipantByCredential(participantToken);
    if (!participant) return res.status(401).json({ error: "participant credential is invalid or expired", code: "UNAUTHENTICATED" });
    if (requiresCsrfOrigin(req.method) && !requestHasTrustedOrigin(req)) {
      return res.status(403).json({ error: "trusted request origin required", code: "CSRF_ORIGIN" });
    }
    req.sessionParticipant = participant;
    req.authTransport = "participant";
    next();
  })().catch(next);
};

export const userOf = (req: express.Request): AuthContext => req.user!;

export const relay = (result: { status: number; json: unknown }, res: express.Response) => res.status(result.status).json(result.json);

// Membership gate for a specific workspace — attaches the caller's role.
export const withWorkspace =
  (handler: (req: express.Request, res: express.Response, ctx: { workspaceId: string; userId: string; role: Role }) => unknown): express.RequestHandler =>
  async (req, res) => {
    const user = userOf(req);
    const workspaceId = String(req.params.wsId);
    const role = await membership(workspaceId, user.userId);
    if (!role) return res.status(404).json({ error: "unknown workspace", code: "UNKNOWN_WORKSPACE" });
    return handler(req, res, { workspaceId, userId: user.userId, role });
  };

export const ownerOnly = (res: express.Response, role: Role): boolean => {
  if (role !== "owner") {
    res.status(403).json({ error: "owner only", code: "FORBIDDEN" });
    return false;
  }
  return true;
};

export interface OperatorIdentity {
  email: string;
  githubLogin: string | null;
}

export interface WorkspacePeonContext {
  record: PeonRecord;
  operator: OperatorIdentity;
  workspaceId: string;
  userId: string;
  role: Role;
  participant?: SessionParticipantAuth;
}

// Proxy to one peon in the workspace — membership + ownership enforced first.
export const withWorkspacePeon =
  (
    handler: (req: express.Request, res: express.Response, ctx: WorkspacePeonContext) => unknown,
    options: { allowWorkspaceMemberWithoutPeonAccess?: boolean } = {},
  ): express.RequestHandler =>
  async (req, res) => {
    const workspaceId = String(req.params.wsId);
    const peonId = String(req.params.id ?? req.params.peonId);
    const record = await registry.get(peonId);
    if (!record || record.workspaceId !== workspaceId) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });

    let participant = req.sessionParticipant;
    const user = req.user;
    const role = user ? await membership(workspaceId, user.userId) : null;
    const normalPeonAccess = user && role ? await canAccessPeon(workspaceId, user.userId, role, record.peonId) : false;
    const sharedSessionId = participantSessionIdForRequest(req);
    const normalSessionAccess = user && sharedSessionId
      ? await canAccessIndexedSessionNow(workspaceId, user.userId, record.peonId, sharedSessionId)
      : false;
    // A normal grant wins over an invitation row. This keeps existing operators
    // on the ordinary ACL/attribution path and prevents invitation limits from
    // being charged to them. Access is decided at the session, not merely the
    // Peon: a member may see a Peon while a project ACL still hides this session.
    if (!participant && user && sharedSessionId && !normalSessionAccess) {
      participant = await getSessionParticipantForUser(workspaceId, record.peonId, sharedSessionId, user.userId) ?? undefined;
    }
    if (participant) {
      if (participant.workspaceId !== workspaceId || participant.peonId !== record.peonId) {
        return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
      }
      const requestedSessionId = participantSessionIdForRequest(req);
      if (!requestedSessionId || participant.sessionId !== requestedSessionId) {
        return res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
      }
      try {
        const authorization = await authorizeSessionParticipantRequest(participant, req);
        req.sessionParticipantCommandId = authorization.commandId;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "PARTICIPANT_FORBIDDEN";
        const status = error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number"
          ? Number((error as { status: number }).status)
          : 403;
        const message = error instanceof Error ? error.message : "participant action is not allowed";
        return res.status(status).json({ error: message, code });
      }
      return handler(req, res, {
        record,
        operator: { email: participant.actor, githubLogin: participant.githubLogin },
        workspaceId,
        userId: participant.userId ?? participant.guestId ?? participant.participantId,
        role: "member",
        participant,
      });
    }

    if (!user) return res.status(401).json({ error: "authentication required", code: "UNAUTHENTICATED" });
    if (!role) return res.status(404).json({ error: "unknown workspace", code: "UNKNOWN_WORKSPACE" });
    if (!normalPeonAccess && !options.allowWorkspaceMemberWithoutPeonAccess) {
      return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
    }
    if (typeof req.params.sid === "string" && normalSessionAccess) {
      await ensureDirectSessionParticipant(workspaceId, record.peonId, String(req.params.sid), user);
    }
    // Identity fields stay separate. Peon-Actor is deliberately the immutable,
    // canonical email; GitHub login is profile metadata and never substitutes it.
    return handler(req, res, {
      record,
      operator: { email: user.email, githubLogin: user.githubLogin },
      workspaceId,
      userId: user.userId,
      role,
    });
  };

export const restSegments = (req: express.Request): string[] => (req.params.rest as unknown as string[] | undefined) ?? [];
