import express from "express";
import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import {
  requestHasTrustedOrigin,
  requiresCsrfOrigin,
  verifyDeviceToken,
  webSessionToken,
} from "../auth/index.js";
import { membership } from "../../workspaces.js";
import { bearer, clientInfo } from "../../routes/helpers.js";
import {
  CLAIM_CAPABILITY,
  CLAIM_PROTOCOL,
  CLAIM_TTL_MS,
  CLOCK_SKEW_MS,
  DELIVERY_TTL_MS,
  MAX_BODY_BYTES,
  POLL_AFTER_MS,
  claimKeysConfigured,
} from "./claimCrypto.js";
import {
  acknowledgeClaim,
  acknowledgeRotation,
  cancelClaim,
  claimError,
  decideClaim,
  pollClaim,
  pollRotation,
  resolveClaim,
  revocationTargetExists,
  revokeClaimCredential,
  revokeClaimPeon,
  startClaim,
  startRotation,
} from "./claimService.js";
import { ClaimServiceError } from "./claimTypes.js";

type AsyncHandler = (req: express.Request, res: express.Response) => Promise<unknown>;
const strictClaimJson = express.json({ limit: MAX_BODY_BYTES, strict: true });

function noStore(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function sourceIp(req: express.Request): string {
  return clientInfo(req).ip ?? "unknown";
}

function protocolError(res: express.Response, error: unknown): void {
  const known = error instanceof ClaimServiceError ? error : claimError("INTERNAL");
  const allowed = Object.fromEntries(Object.entries(known.extra).filter(([key]) =>
    ["retryAfterMs", "state", "claimId", "expiresAt"].includes(key)));
  res.status(known.status).json({
    type: "claim_error",
    protocol: CLAIM_PROTOCOL,
    code: known.code,
    message: known.message,
    serverTime: typeof known.extra.serverTime === "number" ? known.extra.serverTime : Date.now(),
    ...allowed,
  });
}

function operatorError(res: express.Response, code: "UNAUTHENTICATED" | "CSRF_ORIGIN" | "FORBIDDEN" | "NOT_FOUND"): void {
  const messages = {
    UNAUTHENTICATED: "authentication required",
    CSRF_ORIGIN: "trusted request origin required",
    FORBIDDEN: "workspace owner role required",
    NOT_FOUND: "revocation target not found",
  };
  const statuses = { UNAUTHENTICATED: 401, CSRF_ORIGIN: 403, FORBIDDEN: 403, NOT_FOUND: 404 };
  res.status(statuses[code]).json({ type: "operator_error", protocol: 1, code, message: messages[code], serverTime: Date.now() });
}

function asyncRoute(handler: AsyncHandler): express.RequestHandler {
  return (req, res) => {
    void handler(req, res).catch((error) => protocolError(res, error));
  };
}

function objectBody(req: express.Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw claimError("BAD_REQUEST");
  if (((req as express.Request & { rawJsonBytes?: number }).rawJsonBytes ?? 0) > MAX_BODY_BYTES) throw claimError("BAD_REQUEST");
  if (Buffer.byteLength(JSON.stringify(req.body)) > MAX_BODY_BYTES) throw claimError("BAD_REQUEST");
  return req.body as Record<string, unknown>;
}

export function publicPeonClaimRouter(): express.Router {
  const router = express.Router();
  router.use(noStore);
  router.get("/peon-claims/capabilities", asyncRoute(async (_req, res) => {
    if (!claimKeysConfigured()) throw claimError("UNSUPPORTED_CAPABILITY");
    const serverTime = Date.now();
    res.json({
      type: "claim_capabilities",
      protocol: CLAIM_PROTOCOL,
      capability: CLAIM_CAPABILITY,
      transport: "https-short-poll",
      pollAfterMs: POLL_AFTER_MS,
      claimTtlMs: CLAIM_TTL_MS,
      deliveryTtlMs: DELIVERY_TTL_MS,
      clockSkewMs: CLOCK_SKEW_MS,
      maxBodyBytes: MAX_BODY_BYTES,
      serverTime,
    });
  }));
  router.post("/peon-claims", strictClaimJson, asyncRoute(async (req, res) => {
    res.status(201).json(await startClaim(objectBody(req), sourceIp(req)));
  }));
  router.post("/peon-claims/:claimId/poll", strictClaimJson, asyncRoute(async (req, res) => {
    res.json(await pollClaim(String(req.params.claimId), objectBody(req), bearer(req)));
  }));
  router.post("/peon-claims/:claimId/cancel", strictClaimJson, asyncRoute(async (req, res) => {
    res.json(await cancelClaim(String(req.params.claimId), objectBody(req), bearer(req)));
  }));
  router.post("/peon-claims/:claimId/ack", strictClaimJson, asyncRoute(async (req, res) => {
    res.json(await acknowledgeClaim(String(req.params.claimId), objectBody(req), bearer(req)));
  }));
  router.post("/peon-credentials/rotations", strictClaimJson, asyncRoute(async (req, res) => {
    const result = await startRotation(objectBody(req), bearer(req));
    res.status(result.replayed === true ? 200 : 201).json(result);
  }));
  router.post("/peon-credentials/rotations/:rotationId/poll", strictClaimJson, asyncRoute(async (req, res) => {
    res.json(await pollRotation(String(req.params.rotationId), objectBody(req), bearer(req)));
  }));
  router.post("/peon-credentials/rotations/:rotationId/ack", strictClaimJson, asyncRoute(async (req, res) => {
    res.json(await acknowledgeRotation(String(req.params.rotationId), objectBody(req), bearer(req)));
  }));
  router.use((
    _error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => protocolError(res, claimError("BAD_REQUEST")));
  return router;
}

export function operatorPeonClaimRouter(): express.Router {
  const router = express.Router();
  router.use(noStore);
  router.use((req, res, next) => {
    void (async () => {
      const token = bearer(req);
      const transport = token ? "bearer" : "cookie";
      const auth = await verifyDeviceToken(token || webSessionToken(req));
      if (!auth) return operatorError(res, "UNAUTHENTICATED");
      if (transport === "cookie" && requiresCsrfOrigin(req.method) && !requestHasTrustedOrigin(req)) {
        return operatorError(res, "CSRF_ORIGIN");
      }
      req.user = auth;
      req.authTransport = transport;
      next();
    })().catch(next);
  });
  router.post("/peon-claims/resolve", asyncRoute(async (req, res) => {
    res.json(await resolveClaim(objectBody(req), sourceIp(req), req.user!.userId));
  }));
  router.post("/workspaces/:wsId/peon-claims/:claimId/decision", asyncRoute(async (req, res) => {
    const body = objectBody(req);
    if (Object.keys(body).sort().join(",") !== "claimId,decision,protocol,type"
      || body.type !== "claim_decision" || body.protocol !== 1
      || body.claimId !== String(req.params.claimId)
      || (body.decision !== "approve" && body.decision !== "deny")) throw claimError("BAD_REQUEST");
    const workspaceId = String(req.params.wsId);
    if (body.decision === "approve" && await membership(workspaceId, req.user!.userId) !== "owner") throw claimError("FORBIDDEN");
    res.json(await decideClaim(workspaceId, String(req.params.claimId), body.decision, req.user!.userId));
  }));
  router.post(
    "/workspaces/:wsId/peons/:peonId/credentials/:credentialId/revoke",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.wsId);
      const peonId = String(req.params.peonId);
      const credentialId = String(req.params.credentialId);
      const body = objectBody(req);
      if (Object.keys(body).sort().join(",") !== "credentialId,protocol,type"
        || body.type !== "credential_revocation" || body.protocol !== 1 || body.credentialId !== credentialId) {
        throw claimError("BAD_REQUEST");
      }
      if (!(await revocationTargetExists("credential", workspaceId, peonId, credentialId))) return operatorError(res, "NOT_FOUND");
      const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 128) : randomUUID();
      let result: Record<string, unknown> | null;
      try {
        result = await revokeClaimCredential(workspaceId, peonId, credentialId, req.user!.userId, requestId);
      } catch (error) {
        if (error instanceof ClaimServiceError && error.code === "FORBIDDEN") {
          return operatorError(res, "FORBIDDEN");
        }
        throw error;
      }
      if (!result) return operatorError(res, "NOT_FOUND");
      res.json(result);
    }),
  );
  router.post(
    "/workspaces/:wsId/peons/:peonId/revoke",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.wsId);
      const peonId = String(req.params.peonId);
      const body = objectBody(req);
      if (Object.keys(body).sort().join(",") !== "peonId,protocol,type"
        || body.type !== "peon_revocation" || body.protocol !== 1 || body.peonId !== peonId) {
        throw claimError("BAD_REQUEST");
      }
      if (!(await revocationTargetExists("peon", workspaceId, peonId))) return operatorError(res, "NOT_FOUND");
      const requestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 128) : randomUUID();
      let result: Record<string, unknown> | null;
      try {
        result = await revokeClaimPeon(workspaceId, peonId, req.user!.userId, requestId);
      } catch (error) {
        if (error instanceof ClaimServiceError && error.code === "FORBIDDEN") {
          return operatorError(res, "FORBIDDEN");
        }
        throw error;
      }
      if (!result) return operatorError(res, "NOT_FOUND");
      res.json(result);
    }),
  );
  return router;
}

export function peonClaimPublicOrigin(): string {
  return config.publicUrl;
}
