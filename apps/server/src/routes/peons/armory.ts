import express from "express";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { relay, withWorkspacePeon } from "../helpers.js";

const root = "/workspaces/:wsId/peons/:id/armory";

type RelayResult = { status: number; json: unknown };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizeArmoryResult(value: unknown): unknown {
  const json = record(value);
  const operation = record(json?.operation);
  if (!json || !operation) return value;
  const { percent, ...publicOperation } = operation;
  const candidate = operation.progress ?? percent;
  const progress = typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.min(100, candidate))
    : null;
  return { ...json, operation: { ...publicOperation, progress } };
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
    relay(await callPeon(connOfRecord(ctx.record), "GET", `/armory/packages${inventoryQuery(req.query)}`, { actor: ctx.operator.email }), res);
  }));
  router.post(`${root}/refresh`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    relay(await callPeon(connOfRecord(ctx.record), "POST", "/armory/refresh", { actor: ctx.operator.email }), res);
  }));
  router.post(`${root}/packages/:packageId/install`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const version = typeof req.body?.version === "string" && req.body.version.trim() ? req.body.version.trim() : null;
    relay(await callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/install`, {
      actor: ctx.operator.email,
      body: version ? { version } : {},
    }), res);
  }));
  router.post(`${root}/packages/:packageId/update`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const version = typeof req.body?.version === "string" && req.body.version.trim() ? req.body.version.trim() : null;
    relay(await callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/update`, {
      actor: ctx.operator.email,
      body: version ? { version } : {},
    }), res);
  }));
  router.delete(`${root}/packages/:packageId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await callPeon(connOfRecord(ctx.record), "DELETE", `/armory/packages/${packageId}`, { actor: ctx.operator.email, body: {} }), res);
  }));
  router.get(`${root}/packages/:packageId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await callPeon(connOfRecord(ctx.record), "GET", `/armory/packages/${packageId}/configuration`, { actor: ctx.operator.email }), res);
  }));
  router.get(`${root}/packages/:packageId/mcp`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await callPeon(connOfRecord(ctx.record), "GET", `/armory/packages/${packageId}/mcp`, { actor: ctx.operator.email }), res);
  }));
  for (const action of ["enable", "disable"] as const) {
    router.post(`${root}/packages/:packageId/${action}`, withWorkspacePeon(async (req, res, ctx) => {
      res.setHeader("Cache-Control", "no-store");
      const packageId = encodeURIComponent(String(req.params.packageId));
      relay(await callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/${action}`, { actor: ctx.operator.email }), res);
    }));
  }
  router.post(`${root}/packages/:packageId/configuration/verify`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/configuration/verify`, { actor: ctx.operator.email }), res);
  }));
  router.put(`${root}/packages/:packageId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const body = {
      values: req.body?.values,
      ...(req.body?.confirmHostWrites === true ? { confirmHostWrites: true } : {}),
    };
    relay(safeConfigurationResult(await callPeon(connOfRecord(ctx.record), "PUT", `/armory/packages/${packageId}/configuration`, { actor: ctx.operator.email, body }), true), res);
  }));
  router.delete(`${root}/packages/:packageId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const packageId = encodeURIComponent(String(req.params.packageId));
    const body = {
      ...(req.body?.includeHost === true ? { includeHost: true } : {}),
      ...(req.body?.confirmHostWrites === true ? { confirmHostWrites: true } : {}),
    };
    relay(await callPeon(connOfRecord(ctx.record), "DELETE", `/armory/packages/${packageId}/configuration`, { actor: ctx.operator.email, body }), res);
  }));
  router.get(`${root}/packages/:packageId`, withWorkspacePeon(async (req, res, ctx) => {
    const packageId = encodeURIComponent(String(req.params.packageId));
    relay(await callPeon(connOfRecord(ctx.record), "GET", `/armory/packages/${packageId}`, { actor: ctx.operator.email }), res);
  }));
  router.get(`${root}/settings`, withWorkspacePeon(async (req, res, ctx) => {
    relay(await callPeon(connOfRecord(ctx.record), "GET", "/armory/settings", { actor: ctx.operator.email }), res);
  }));
  router.get(`${root}/operations/:operationId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const operationId = encodeURIComponent(String(req.params.operationId));
    relay(safeConfigurationResult(await callPeon(connOfRecord(ctx.record), "GET", `/armory/operations/${operationId}`, { actor: ctx.operator.email })), res);
  }));
}
