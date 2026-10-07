import express from "express";
import { canAccessProject } from "../../modules/access/index.js";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { relay, withWorkspacePeon } from "../requestContext.js";

const root = "/workspaces/:wsId/peons/:id/armory";
const ARMORY_PROJECT_PACKAGES_CAPABILITY = "armory-project-packages-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROFILE_TYPE = /^[a-z][a-z0-9.-]{0,63}$/;
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_PROFILES = 100;
const MAX_ASSIGNMENTS = 100;
const MAX_PROFILE_FIELDS = 64;
const MAX_PROFILE_VALUE_LENGTH = 1024 * 1024;
const MAX_IDENTITY_LABEL_LENGTH = 120;
const MAX_IDENTITY_VALUE_LENGTH = 320;
const PROFILE_STATUSES = new Set(["missing", "unverified", "verified", "invalid"]);
const PROFILE_OPERATION_KINDS = new Set(["profile_configure", "profile_verify"]);
const PROFILE_OPERATION_STATUSES = new Set(["queued", "running", "succeeded", "failed"]);
const SAFE_PROJECT_PACKAGES_CODES = new Set([
  "ARMORY_ACTIVATION_RETIRED",
  "ASSIGNMENT_NOT_FOUND",
  "BAD_REQUEST",
  "CONNECTION_REFUSED",
  "CONNECTION_TIMEOUT",
  "DNS_FAILURE",
  "INTERNAL",
  "NOT_FOUND",
  "OPERATION_IN_PROGRESS",
  "PACKAGE_NOT_INSTALLED",
  "PACKAGE_NOT_READY",
  "PEON_UNREACHABLE",
  "PROFILE_FIELDS_MISSING",
  "PROFILE_IN_USE",
  "PROFILE_LIMIT_REACHED",
  "PROFILE_NOT_FOUND",
  "PROFILE_NOT_VERIFIED",
  "PROFILE_TYPE_MISMATCH",
  "PROJECT_NOT_FOUND",
  "TLS_FAILURE",
  "UNSUPPORTED_CAPABILITY",
]);

type RelayResult = { status: number; json: unknown; requestId?: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requestId(req: express.Request): string | undefined {
  return req.header("Peon-Request-Id") || undefined;
}

function invalidRequest(res: express.Response, error: string): void {
  res.status(400).json({ error, code: "BAD_REQUEST" });
}

function requireCapability(res: express.Response, capabilities: readonly string[]): boolean {
  if (capabilities.includes(ARMORY_PROJECT_PACKAGES_CAPABILITY)) return true;
  res.status(409).json({
    error: "This Peon does not support typed Armory profiles and project assignments.",
    code: "UNSUPPORTED_CAPABILITY",
  });
  return false;
}

function safeProjectPackagesError(result: RelayResult, sensitive = false): RelayResult {
  const json = record(result.json);
  const candidate = typeof json?.code === "string" && ERROR_CODE.test(json.code) && SAFE_PROJECT_PACKAGES_CODES.has(json.code)
    ? json.code
    : "ARMORY_REQUEST_FAILED";
  const message = sensitive
    ? "Peon rejected the profile configuration request."
    : "Peon rejected the Armory request.";
  return { status: result.status, json: { error: message, code: candidate }, requestId: result.requestId };
}

function unsafeProjectPackagesResult(): RelayResult {
  return {
    status: 502,
    json: { error: "Peon returned an unsafe Armory response.", code: "UNSAFE_ARMORY_RESULT" },
  };
}

// A Peon older than the identity contract sends no `identity` at all, which is
// simply "no identity". A present but malformed one is a Peon that is not
// speaking this contract, and the whole response is refused rather than shown.
function safeIdentity(value: unknown): { ok: true; identity: Record<string, string> | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, identity: null };
  const identity = record(value);
  if (!identity || typeof identity.label !== "string" || typeof identity.value !== "string"
    || identity.label.length < 1 || identity.label.length > MAX_IDENTITY_LABEL_LENGTH
    || identity.value.length < 1 || identity.value.length > MAX_IDENTITY_VALUE_LENGTH) return { ok: false };
  return { ok: true, identity: { label: identity.label, value: identity.value } };
}

function safeProfile(value: unknown): Record<string, unknown> | null {
  const profile = record(value);
  if (!profile || !UUID.test(String(profile.profileId)) || !PROFILE_TYPE.test(String(profile.type))
    || typeof profile.name !== "string" || profile.name.trim().length < 1 || profile.name.length > 80
    || typeof profile.status !== "string" || !PROFILE_STATUSES.has(profile.status)) return null;
  const configured = record(profile.configuredFields);
  if (!configured || Object.keys(configured).length > MAX_PROFILE_FIELDS
    || Object.entries(configured).some(([field, present]) => !FIELD_ID.test(field) || present !== true)) return null;
  const identity = safeIdentity(profile.identity);
  if (!identity.ok) return null;
  return {
    profileId: profile.profileId,
    type: profile.type,
    name: profile.name,
    status: profile.status,
    configuredFields: { ...configured },
    identity: identity.identity,
  };
}

function safeAssignment(value: unknown): Record<string, unknown> | null {
  const assignment = record(value);
  if (!assignment || !UUID.test(String(assignment.projectId)) || !PACKAGE_ID.test(String(assignment.packageId))
    || (assignment.profileId !== null && !UUID.test(String(assignment.profileId)))) return null;
  return {
    projectId: assignment.projectId,
    packageId: assignment.packageId,
    profileId: assignment.profileId,
  };
}

function safeProfileOperation(value: unknown): Record<string, unknown> | null {
  const operation = record(value);
  if (!operation || !UUID.test(String(operation.operationId)) || typeof operation.kind !== "string"
    || !PROFILE_OPERATION_KINDS.has(operation.kind) || typeof operation.status !== "string"
    || !PROFILE_OPERATION_STATUSES.has(operation.status)
    || (operation.code !== null && operation.code !== undefined
      && (typeof operation.code !== "string" || !SAFE_PROJECT_PACKAGES_CODES.has(operation.code)))) return null;
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    status: operation.status,
    code: typeof operation.code === "string" ? operation.code : null,
  };
}

export function safeProfileResult(result: RelayResult, list = false): RelayResult {
  if (result.status < 200 || result.status >= 300) return safeProjectPackagesError(result);
  if (list) {
    const json = record(result.json);
    if (!Array.isArray(json?.profiles) || json.profiles.length > MAX_PROFILES) return unsafeProjectPackagesResult();
    const profiles = json.profiles.map(safeProfile);
    if (profiles.some((profile) => profile === null)) return unsafeProjectPackagesResult();
    return { ...result, json: { profiles } };
  }
  const profile = safeProfile(result.json);
  return profile ? { ...result, json: profile } : unsafeProjectPackagesResult();
}

export function safeAssignmentResult(result: RelayResult, list = false): RelayResult {
  if (result.status < 200 || result.status >= 300) return safeProjectPackagesError(result);
  if (list) {
    const json = record(result.json);
    if (!Array.isArray(json?.assignments) || json.assignments.length > MAX_ASSIGNMENTS) return unsafeProjectPackagesResult();
    const assignments = json.assignments.map(safeAssignment);
    if (assignments.some((assignment) => assignment === null)) return unsafeProjectPackagesResult();
    return { ...result, json: { assignments } };
  }
  const assignment = safeAssignment(result.json);
  return assignment ? { ...result, json: assignment } : unsafeProjectPackagesResult();
}

export function safeProfileOperationResult(result: RelayResult, sensitive = false): RelayResult {
  if (result.status < 200 || result.status >= 300) return safeProjectPackagesError(result, sensitive);
  const operation = safeProfileOperation(result.json);
  return operation ? { ...result, json: operation } : unsafeProjectPackagesResult();
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
  if (operation && PROFILE_OPERATION_KINDS.has(String(operation.kind))) {
    const safe = safeProfileOperation(operation);
    return safe ? { ...result, json: { operation: safe } } : unsafeProjectPackagesResult();
  }
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

function createProfileBody(value: unknown): { type: string; name: string } | null {
  const body = record(value);
  if (!body || !exactKeys(body, ["type", "name"]) || typeof body.type !== "string" || !PROFILE_TYPE.test(body.type)
    || typeof body.name !== "string" || body.name.trim().length < 1 || body.name.length > 80) return null;
  return { type: body.type, name: body.name.trim() };
}

function renameProfileBody(value: unknown): { name: string } | null {
  const body = record(value);
  if (!body || !exactKeys(body, ["name"]) || typeof body.name !== "string"
    || body.name.trim().length < 1 || body.name.length > 80) return null;
  return { name: body.name.trim() };
}

function profileConfigurationBody(value: unknown): { values: Record<string, string> } | null {
  const body = record(value);
  const values = record(body?.values);
  if (!body || !exactKeys(body, ["values"]) || !values || Object.keys(values).length > MAX_PROFILE_FIELDS
    || Object.entries(values).some(([field, fieldValue]) => !FIELD_ID.test(field)
      || typeof fieldValue !== "string" || fieldValue.length > MAX_PROFILE_VALUE_LENGTH)) return null;
  return { values: values as Record<string, string> };
}

function assignmentBody(value: unknown): { profileId: string | null } | null {
  const body = record(value);
  if (!body || !exactKeys(body, ["profileId"]) || (body.profileId !== null && !UUID.test(String(body.profileId)))) return null;
  return { profileId: body.profileId as string | null };
}

function profileId(req: express.Request, res: express.Response): string | null {
  const value = String(req.params.profileId);
  if (UUID.test(value)) return value;
  invalidRequest(res, "profileId must be a lowercase UUID.");
  return null;
}

function assignmentIds(req: express.Request, res: express.Response): { projectId: string; packageId?: string } | null {
  const projectId = String(req.params.projectId);
  if (!UUID.test(projectId)) {
    invalidRequest(res, "projectId must be a lowercase UUID.");
    return null;
  }
  if (req.params.packageId !== undefined) {
    const packageId = String(req.params.packageId);
    if (!PACKAGE_ID.test(packageId)) {
      invalidRequest(res, "packageId is invalid.");
      return null;
    }
    return { projectId, packageId };
  }
  return { projectId };
}

export function registerArmoryRoutes(router: express.Router): void {
  router.get(`${root}/profiles`, withWorkspacePeon(async (_req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    relay(safeProfileResult(await callPeon(connOfRecord(ctx.record), "GET", "/armory/profiles", { actor: ctx.operator.email }), true), res);
  }));
  router.post(`${root}/profiles`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const body = createProfileBody(req.body);
    if (!body) return invalidRequest(res, "A profile type and bounded name are required.");
    relay(safeProfileResult(await callPeon(connOfRecord(ctx.record), "POST", "/armory/profiles", {
      actor: ctx.operator.email,
      body,
      requestId: requestId(req),
    })), res);
  }));
  router.patch(`${root}/profiles/:profileId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const id = profileId(req, res);
    if (!id) return;
    const body = renameProfileBody(req.body);
    if (!body) return invalidRequest(res, "A bounded profile name is required.");
    relay(safeProfileResult(await callPeon(connOfRecord(ctx.record), "PATCH", `/armory/profiles/${id}`, {
      actor: ctx.operator.email,
      body,
      requestId: requestId(req),
    })), res);
  }));
  router.delete(`${root}/profiles/:profileId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const id = profileId(req, res);
    if (!id) return;
    relay(safeProfileResult(await callPeon(connOfRecord(ctx.record), "DELETE", `/armory/profiles/${id}`, {
      actor: ctx.operator.email,
      requestId: requestId(req),
    })), res);
  }));
  router.put(`${root}/profiles/:profileId/configuration`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const id = profileId(req, res);
    if (!id) return;
    const body = profileConfigurationBody(req.body);
    if (!body) return invalidRequest(res, "Profile values must be a bounded map of field IDs to strings.");
    relay(safeProfileOperationResult(await callPeon(connOfRecord(ctx.record), "PUT", `/armory/profiles/${id}/configuration`, {
      actor: ctx.operator.email,
      body,
      requestId: requestId(req),
    }), true), res);
  }));
  router.post(`${root}/profiles/:profileId/verify`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const id = profileId(req, res);
    if (!id) return;
    relay(safeProfileOperationResult(await callPeon(connOfRecord(ctx.record), "POST", `/armory/profiles/${id}/verify`, {
      actor: ctx.operator.email,
      requestId: requestId(req),
    }), true), res);
  }));
  router.get(`${root}/projects/:projectId/assignments`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const ids = assignmentIds(req, res);
    if (!ids) return;
    if (!(await canAccessProject(ctx.workspaceId, ctx.userId, ctx.role, ctx.record.peonId, "", ids.projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    relay(safeAssignmentResult(await callPeon(connOfRecord(ctx.record), "GET", `/armory/projects/${ids.projectId}/assignments`, {
      actor: ctx.operator.email,
    }), true), res);
  }));
  router.put(`${root}/projects/:projectId/assignments/:packageId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const ids = assignmentIds(req, res);
    if (!ids?.packageId) return;
    if (!(await canAccessProject(ctx.workspaceId, ctx.userId, ctx.role, ctx.record.peonId, "", ids.projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    const body = assignmentBody(req.body);
    if (!body) return invalidRequest(res, "profileId must be null or a lowercase UUID.");
    relay(safeAssignmentResult(await callPeon(connOfRecord(ctx.record), "PUT", `/armory/projects/${ids.projectId}/assignments/${ids.packageId}`, {
      actor: ctx.operator.email,
      body,
      requestId: requestId(req),
    })), res);
  }));
  router.delete(`${root}/projects/:projectId/assignments/:packageId`, withWorkspacePeon(async (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    if (!requireCapability(res, ctx.record.capabilities)) return;
    const ids = assignmentIds(req, res);
    if (!ids?.packageId) return;
    if (!(await canAccessProject(ctx.workspaceId, ctx.userId, ctx.role, ctx.record.peonId, "", ids.projectId))) {
      return res.status(404).json({ error: "unknown project", code: "UNKNOWN_PROJECT" });
    }
    relay(safeAssignmentResult(await callPeon(connOfRecord(ctx.record), "DELETE", `/armory/projects/${ids.projectId}/assignments/${ids.packageId}`, {
      actor: ctx.operator.email,
      requestId: requestId(req),
    })), res);
  }));
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
      if (ctx.record.capabilities.includes(ARMORY_PROJECT_PACKAGES_CAPABILITY)) {
        return res.status(410).json({ error: "Armory package activation is retired for this Peon.", code: "ARMORY_ACTIVATION_RETIRED" });
      }
      const rawPackageId = String(req.params.packageId);
      if (!PACKAGE_ID.test(rawPackageId)) return invalidRequest(res, "packageId is invalid.");
      const packageId = encodeURIComponent(rawPackageId);
      relay(await callPeon(connOfRecord(ctx.record), "POST", `/armory/packages/${packageId}/${action}`, {
        actor: ctx.operator.email,
        requestId: requestId(req),
      }), res);
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
