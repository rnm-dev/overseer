import { isIP } from "node:net";
import express from "express";
import { registry, type PeonRecord } from "../registry.js";
import { membership, type Role } from "../workspaces.js";
import {
  requestHasTrustedOrigin,
  requiresCsrfOrigin,
  type AuthContext,
  verifyDeviceToken,
  webSessionToken,
} from "../modules/auth/index.js";
import { resolveCredential } from "../credentials.js";
import { canAccessPeon } from "../access.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthContext; // set by operatorAuth
      authTransport?: "bearer" | "cookie"; // set by operatorAuth
      peonCred?: { id: string; workspaceId: string; boundPeonId: string | null; method: "legacy" | "claim"; generation: number | null }; // set by credentialAuth
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
      method: cred.method,
      generation: cred.generation,
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
    if (!auth) return res.status(401).json({ error: "authentication required", code: "UNAUTHENTICATED" });
    if (transport === "cookie" && requiresCsrfOrigin(req.method) && !requestHasTrustedOrigin(req)) {
      return res.status(403).json({ error: "trusted request origin required", code: "CSRF_ORIGIN" });
    }
    req.user = auth;
    req.authTransport = transport;
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

// Proxy to one peon in the workspace — membership + ownership enforced first.
export const withWorkspacePeon =
  (handler: (req: express.Request, res: express.Response, ctx: { record: PeonRecord; operator: OperatorIdentity; workspaceId: string; userId: string; role: Role }) => unknown): express.RequestHandler =>
  withWorkspace(async (req, res, ctx) => {
    const record = await registry.get(String(req.params.id));
    if (!record || record.workspaceId !== ctx.workspaceId) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
    if (!(await canAccessPeon(ctx.workspaceId, ctx.userId, ctx.role, record.peonId))) return res.status(404).json({ error: "unknown peon", code: "UNKNOWN_PEON" });
    // Identity fields stay separate. Peon-Actor is deliberately the immutable,
    // canonical email; GitHub login is profile metadata and never substitutes it.
    return handler(req, res, {
      record,
      operator: { email: req.user!.email, githubLogin: req.user!.githubLogin },
      ...ctx,
    });
  });

export const restSegments = (req: express.Request): string[] => (req.params.rest as unknown as string[] | undefined) ?? [];
