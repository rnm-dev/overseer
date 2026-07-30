import express from "express";
import { callPeon, connOfRecord } from "../../peonClient.js";
import { reverseCommandGateway, type JsonObject, type ReverseCommandOperation } from "../../modules/reverseCommands/index.js";
import { runReverseCommandTransport } from "../../modules/reverseCommandTransport.js";
import type { PeonRecord } from "../../registry.js";
import { relay, withWorkspacePeon } from "../helpers.js";

const root = "/workspaces/:wsId/peons/:id/armory";

type RelayResult = { status: number; json: unknown };

async function armoryCall(
  req: express.Request,
  ctx: { record: PeonRecord; workspaceId: string },
  operation: ReverseCommandOperation,
  target: { packageId?: string; operationId?: string },
  payload: JsonObject,
  legacy: () => Promise<RelayResult & { ok?: boolean }>,
): Promise<RelayResult> {
  return runReverseCommandTransport<RelayResult>({
    peonId: ctx.record.peonId,
    operation,
    reverse: async () => {
      const response = await reverseCommandGateway.submit({
        workspaceId: ctx.workspaceId,
        peonId: ctx.record.peonId,
        auth: req.user!,
        operation,
        target,
        payload,
        waitMs: 15_000,
      });
      const body = response.body;
      if (response.status >= 200 && response.status < 300 && body.state === "terminal") {
        return { status: response.status, json: body.result };
      }
      return { status: response.status, json: body };
    },
    legacy,
    unavailable: async (reason) => ({
      status: 503,
      json: {
        error: "Peon transport is unavailable",
        code: "REVERSE_TRANSPORT_UNAVAILABLE",
        reason,
      },
    }),
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// Configuration failures and operation diagnostics cross a trust boundary from
// Peon. Never relay free-form text that could contain a submitted credential or
// file payload.
export function safeConfigurationResult(result: RelayResult, mutation = false): RelayResult {
  const json = record(result.json);
  if (mutation && (result.status < 200 || result.status >= 300)) {
    return {
      status: result.status,
      json: {
        error: "Peon rejected the configuration.",
        code: json?.code === "OPERATION_IN_PROGRESS" ? "OPERATION_IN_PROGRESS" : "CONFIGURATION_REJECTED",
      },
    };
  }
  const operation = record(json?.operation);
  if (operation?.kind !== "configure") return result;
  return {
    ...result,
    json: {
      ...json,
      operation: { ...operation, phase: "configuration", message: "", errorCode: null },
    },
  };
}

function inventoryQuery(query: express.Request["query"]): string {
  const params = new URLSearchParams();
  for (const key of ["q", "installed", "limit", "cursor"] as const) {
    const value = query[key];
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

export function registerArmoryRoutes(router: express.Router): void {
  router.get(`${root}/packages`, withWorkspacePeon(async (req, res, ctx) => {
    const payload: JsonObject = {};
    if (typeof req.query.q === "string") payload.q = req.query.q;
    if (req.query.installed === "true" || req.query.installed === "1") payload.installedOnly = true;
    if (typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit)) payload.limit = Number(req.query.limit);
    if (typeof req.query.cursor === "string") payload.cursor = req.query.cursor;
    relay(await armoryCall(req, ctx, "armory.inventory", {}, payload,
      () => callPeon(connOfRecord(ctx.record), "GET", `/armory/packages${inventoryQuery(req.query)}`, { actor: ctx.operator.email })), res);
  }));
  router.post(`${root}/refresh`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    relay(await armoryCall(req, ctx, "armory.refresh", {}, {},
      () => callPeon(connOfRecord(ctx.record), "POST", "/armory/refresh", { actor: ctx.operator.email })), res);
  }));
  router.post(`${root}/packages/:packageId/install`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const version = typeof req.body?.version === "string" && req.body.version.trim() ? req.body.version.trim() : null;
    relay(await armoryCall(req, ctx, "armory.install", { packageId: String(req.params.packageId) }, version ? { version } : {}, () => callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/install`, {
      actor: ctx.operator.email,
      body: version ? { version } : {},
    })), res);
  }));
  router.post(`${root}/packages/:packageId/update`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const version = typeof req.body?.version === "string" && req.body.version.trim() ? req.body.version.trim() : null;
    relay(await armoryCall(req, ctx, "armory.update", { packageId: String(req.params.packageId) }, version ? { version } : {}, () => callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/update`, {
      actor: ctx.operator.email,
      body: version ? { version } : {},
    })), res);
  }));
  router.delete(`${root}/packages/:packageId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await armoryCall(req, ctx, "armory.uninstall", { packageId: String(req.params.packageId) }, {},
      () => callPeon(connOfRecord(ctx.record), "DELETE", `/armory/packages/${packageId}`, { actor: ctx.operator.email, body: {} })), res);
  }));
  router.get(`${root}/packages/:packageId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await armoryCall(req, ctx, "armory.configuration", { packageId: String(req.params.packageId) }, {},
      () => callPeon(connOfRecord(ctx.record), "GET", `/armory/packages/${packageId}/configuration`, { actor: ctx.operator.email })), res);
  }));
  router.get(`${root}/packages/:packageId/mcp`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await armoryCall(req, ctx, "armory.mcp", { packageId: String(req.params.packageId) }, {},
      () => callPeon(connOfRecord(ctx.record), "GET", `/armory/packages/${packageId}/mcp`, { actor: ctx.operator.email })), res);
  }));
  for (const action of ["enable", "disable"] as const) {
    router.post(`${root}/packages/:packageId/${action}`, withWorkspacePeon(async (req, res, ctx) => {
      res.setHeader("Cache-Control", "no-store");
      const packageId = encodeURIComponent(String(req.params.packageId));
      relay(await armoryCall(req, ctx, `armory.${action}`, { packageId: String(req.params.packageId) }, {},
        () => callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/${action}`, { actor: ctx.operator.email })), res);
    }));
  }
  router.post(`${root}/packages/:packageId/configuration/verify`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await armoryCall(req, ctx, "armory.verify", { packageId: String(req.params.packageId) }, {},
      () => callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/configuration/verify`, { actor: ctx.operator.email })), res);
  }));
  router.put(`${root}/packages/:packageId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const body = {
      values: req.body?.values,
      ...(req.body?.confirmHostWrites === true ? { confirmHostWrites: true } : {}),
    };
    relay(safeConfigurationResult(await armoryCall(req, ctx, "armory.configure", { packageId: String(req.params.packageId) }, body as JsonObject,
      () => callPeon(connOfRecord(ctx.record), "PUT", `/armory/packages/${packageId}/configuration`, { actor: ctx.operator.email, body })), true), res);
  }));
  router.delete(`${root}/packages/:packageId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const body = {
      ...(req.body?.includeHost === true ? { includeHost: true } : {}),
      ...(req.body?.confirmHostWrites === true ? { confirmHostWrites: true } : {}),
    };
    relay(await armoryCall(req, ctx, "armory.configuration.delete", { packageId: String(req.params.packageId) }, body,
      () => callPeon(connOfRecord(ctx.record), "DELETE", `/armory/packages/${packageId}/configuration`, { actor: ctx.operator.email, body })), res);
  }));
  router.get(`${root}/packages/:packageId`, withWorkspacePeon(async (req, res, ctx) => {
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await armoryCall(req, ctx, "armory.package", { packageId: String(req.params.packageId) }, {},
      () => callPeon(connOfRecord(ctx.record), "GET", `/armory/packages/${packageId}`, { actor: ctx.operator.email })), res);
  }));
  router.get(`${root}/settings`, withWorkspacePeon(async (req, res, ctx) => {
    relay(await armoryCall(req, ctx, "armory.settings", {}, {},
      () => callPeon(connOfRecord(ctx.record), "GET", "/armory/settings", { actor: ctx.operator.email })), res);
  }));
  router.get(`${root}/operations/:operationId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const operationId = encodeURIComponent(String(req.params.operationId));
    relay(safeConfigurationResult(await armoryCall(req, ctx, "armory.operation", { operationId: String(req.params.operationId) }, {},
      () => callPeon(connOfRecord(ctx.record), "GET", `/armory/operations/${operationId}`, { actor: ctx.operator.email }))), res);
  }));
}
