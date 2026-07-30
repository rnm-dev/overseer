import express from "express";
import type { PeonRecord } from "../../registry.js";
import { callPeon, connOfRecord, proxyGet, proxyStream } from "../../peonClient.js";
import {
  allowedProjects,
  canAccessIndexedSessionNow,
  canAccessProject,
} from "../../access.js";
import { ownerOnly, relay, withWorkspacePeon } from "../helpers.js";
import { mintWebPreview } from "../../webPreview.js";
import { runIdempotentFollowup, validCommandId } from "../../followupIdempotency.js";
import { enrichTranscriptMetadata } from "../../transcriptTimestamps.js";
import { indexAcceptedSession } from "../../modules/acceptedSession/index.js";
import { cancelSessionRun } from "../../modules/sessionCancel/index.js";
import { deleteIndexedSession, getIndexedSession } from "../../sessionIndex.js";
import { cancelSessionRequest, markSessionAttentionRead, recordSessionRequest } from "../../sessionAttention.js";
import { getIndexedProject, getIndexedProjectById } from "../../projectIndex.js";
import { bus, type LiveEvent } from "../../eventLog.js";
import {
  getTranscriptState,
  readTranscriptAfter,
  readTranscriptPage,
  TranscriptProjectionError,
} from "../../modules/sessions/index.js";
import {
  acquireTranscriptProjection,
  hasReverseTranscriptConnection,
} from "../../peonTranscriptSync.js";
import type { Role } from "../../workspaces.js";

function acceptedSessionId(result: { ok: boolean; json: unknown }): string | null {
  if (!result.ok || !result.json || typeof result.json !== "object") return null;
  const body = result.json as Record<string, unknown>;
  if (typeof body.id === "string") return body.id;
  return body.session && typeof body.session === "object" && typeof (body.session as Record<string, unknown>).id === "string"
    ? String((body.session as Record<string, unknown>).id)
    : null;
}

export function transcriptQuery(query: express.Request["query"], supported: boolean): string {
  if (!supported) return "";
  const params = new URLSearchParams();
  const limit = query.limit;
  const cursor = query.cursor;
  if (typeof limit === "string" && /^\d+$/.test(limit)) params.set("limit", limit);
  if (typeof cursor === "string" && cursor) params.set("cursor", cursor);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

export function registerSessionRoutes(router: express.Router): void {
  const wp = "/workspaces/:wsId/peons/:id";
  const callSupportedPeonPath = async (
    record: PeonRecord,
    method: "GET" | "POST",
    paths: string[],
    actor: string,
    body?: unknown,
  ) => {
    let result = await callPeon(connOfRecord(record), method, paths[0]!, { actor, body });
    for (let index = 1; index < paths.length && (result.status === 404 || result.status === 401); index += 1) {
      result = await callPeon(connOfRecord(record), method, paths[index]!, { actor, body });
    }
    return result;
  };
  const withWorkspaceSession = (
    handler: Parameters<typeof withWorkspacePeon>[0],
    options: { reverseTranscriptAcl?: boolean } = {},
  ) => withWorkspacePeon(async (req, res, c) => {
    if (c.role !== "owner") {
      const sid = String(req.params.sid);
      const indexed = await getIndexedSession(c.record.peonId, sid);
      let projectKey = indexed?.projectKey ?? null;
      let projectId = indexed?.projectId ?? null;
      if (!indexed) {
        const reverseAuthority = options.reverseTranscriptAcl
          && ((await getTranscriptState(c.record.peonId, sid))?.epoch != null
            || hasReverseTranscriptConnection(c.record.peonId));
        if (reverseAuthority) {
          return res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
        }
        const lookup = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email });
        if (!lookup.ok) return relay(lookup, res);
        projectKey = lookup.json && typeof lookup.json === "object" && typeof (lookup.json as { projectKey?: unknown }).projectKey === "string"
          ? (lookup.json as { projectKey: string }).projectKey
          : null;
        projectId = lookup.json && typeof lookup.json === "object" && typeof (lookup.json as { projectId?: unknown }).projectId === "string"
          ? (lookup.json as { projectId: string }).projectId
          : null;
      }
      if (projectKey && !(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId))) {
        return res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
      }
    }
    return handler(req, res, c);
  });
  router.get(`${wp}/status`, withWorkspacePeon(async (_req, res, c) => relay(await callPeon(connOfRecord(c.record), "GET", "/status", { actor: c.operator.email }), res)));
  router.patch(`${wp}/status`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(connOfRecord(c.record), "PATCH", "/status", { actor: c.operator.email, body: req.body }), res);
  }));
  // Provider capabilities + the peon's global default feed the session pickers.
  // `agent`, `model`, and `reasoningEffort` already ride
  // the generic body passthrough, so this read is the only new proxy route needed.
  // Peons that predate model selection have no /models route (they answer 404 —
  // or, on some builds, 401 for the unknown path since /status uses the same creds
  // and works). Degrade those to an empty catalog so the client silently hides the
  // picker instead of the browser logging a failed probe on every peon page.
  router.get(`${wp}/models`, withWorkspacePeon(async (_req, res, c) => {
    const r = await callPeon(connOfRecord(c.record), "GET", "/models", { actor: c.operator.email });
    if (r.status === 404 || r.status === 401) return res.json({ providers: [], defaultModel: null });
    relay(r, res);
  }));
  router.get(`${wp}/sessions`, withWorkspacePeon(async (_req, res, c) => {
    const result = await callPeon(connOfRecord(c.record), "GET", "/sessions", { actor: c.operator.email });
    if (!result.ok || c.role === "owner" || !result.json || typeof result.json !== "object") return relay(result, res);
    const access = (await allowedProjects(c.workspaceId, c.userId, c.role, c.record.peonId)) ?? [];
    const allowedIds = new Set(access.flatMap((item) => item.projectId ? [item.projectId] : []));
    const legacyKeys = new Set(access.filter((item) => !item.projectId).map((item) => item.projectKey));
    const body = result.json as { sessions?: unknown[] };
    const sessions = Array.isArray(body.sessions) ? body.sessions.filter((session) => {
      if (!session || typeof session !== "object") return false;
      const key = (session as { projectKey?: unknown }).projectKey;
      const id = (session as { projectId?: unknown }).projectId;
      return typeof key !== "string" || !key || (typeof id === "string" ? allowedIds.has(id) : legacyKeys.has(key));
    }) : [];
    res.status(result.status).json({ ...body, sessions });
  }));
  router.get(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => {
    const result = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.operator.email });
    // Reading a session is a reconcile point: opening one — and the client's
    // run watchdog polling this same route — republishes the Peon's authoritative
    // record, so a "running" row left behind by a Peon that died mid-run heals
    // for every client instead of waiting for the periodic reconcile. The
    // projection ignores older snapshots and only broadcasts real changes, so
    // repeated reads stay silent.
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
    if (!result.ok || !result.json || typeof result.json !== "object") return relay(result, res);
    const body = result.json as Record<string, unknown>;
    const projectId = typeof body.projectId === "string" ? body.projectId : null;
    const projectKey = typeof body.projectKey === "string" ? body.projectKey : null;
    const project = projectId
      ? await getIndexedProjectById(c.record.peonId, projectId)
      : projectKey ? await getIndexedProject(c.record.peonId, projectKey) : null;
    res.status(result.status).json({
      ...body,
      projectId: projectId ?? project?.projectId ?? null,
      projectRoot: project?.dir ?? null,
    });
  }));
  router.get(`${wp}/sessions/:sid/transcript`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const storedState = await getTranscriptState(c.record.peonId, sid);
    if (storedState?.epoch || hasReverseTranscriptConnection(c.record.peonId)) {
      let release: (() => void) | null = null;
      try {
        if (hasReverseTranscriptConnection(c.record.peonId)) {
          release = await acquireTranscriptProjection(c.record.peonId, sid);
        }
        const rawLimit = typeof req.query.limit === "string" && /^\d+$/.test(req.query.limit)
          ? Number(req.query.limit)
          : 50;
        const page = await readTranscriptPage({
          peonId: c.record.peonId,
          sessionId: sid,
          limit: rawLimit,
          cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
          online: hasReverseTranscriptConnection(c.record.peonId),
        });
        if (page) return res.json(page);
        return res.status(503).json({
          error: "transcript projection is not ready",
          code: "TRANSCRIPT_SYNCING",
          freshness: { state: hasReverseTranscriptConnection(c.record.peonId) ? "syncing" : "offline" },
        });
      } catch (error) {
        if (error instanceof TranscriptProjectionError && error.code === "BAD_CURSOR") {
          return res.status(400).json({ error: error.message, code: "BAD_CURSOR" });
        }
        return res.status(503).json({
          error: error instanceof Error ? error.message : "transcript projection unavailable",
          code: "TRANSCRIPT_UNAVAILABLE",
          freshness: { state: hasReverseTranscriptConnection(c.record.peonId) ? "syncing" : "offline" },
        });
      } finally {
        release?.();
      }
    }
    const query = transcriptQuery(req.query, c.record.capabilities.includes("transcript-pagination-v1"));
    const r = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}/transcript${query}`, { actor: c.operator.email });
    const raw = r.json && typeof r.json === "object" ? (r.json as { raw?: unknown }).raw : undefined;
    // Some peon builds fail the whole transcript endpoint when one JSONL row is corrupt.
    // Keep the session page usable; live tail and session metadata still render.
    if (r.status >= 500 && typeof raw === "string" && raw.includes("JSON.parse") && raw.includes("getTranscript")) return res.json({ events: [] });
    if (r.ok && r.json && typeof r.json === "object") {
      const body = r.json as { events?: unknown };
      if (Array.isArray(body.events)) {
        try {
          const events = await enrichTranscriptMetadata(c.record.peonId, sid, body.events);
          return res.status(r.status).json({ ...body, events });
        } catch {
          // Local metadata enrichment is best-effort; never hide a valid transcript
          // because its local metadata could not be read.
        }
      }
    }
    relay(r, res);
  }, { reverseTranscriptAcl: true }));
  router.post(
    `${wp}/sessions`,
    withWorkspacePeon(async (req, res, c) => {
      const projectKey = typeof req.body?.projectKey === "string" ? req.body.projectKey : null;
      let projectId: string | null = null;
      if (projectKey && c.role !== "owner") {
        const project = await callPeon(connOfRecord(c.record), "GET", `/projects/${encodeURIComponent(projectKey)}`, { actor: c.operator.email });
        projectId = project.ok && project.json && typeof project.json === "object" && typeof (project.json as { projectId?: unknown }).projectId === "string"
          ? (project.json as { projectId: string }).projectId
          : null;
      }
      if (projectKey && !(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId))) return res.status(403).json({ error: "project access required", code: "FORBIDDEN" });
      const requestId = req.headers["peon-request-id"];
      if (requestId !== undefined && !validCommandId(requestId)) {
        return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
      }
      // Control plane owns admission (PROTOCOL: "control plane owns admission"). A
      // peon can be online yet have a broken/unauthenticated Claude CLI — it would
      // accept the session and then fail every run. Refuse to route new work there.
      // Older peons that don't report agentAuth (or report "unknown") pass through:
      // we only block on a definitively bad CLI so un-upgraded peons keep working.
      const blocked = await agentAuthBlocked(c.record, req.body?.agent);
      if (blocked) {
        return res.status(409).json({
          error: blocked === "unauthenticated" ? "this peon's Claude CLI is not signed in — sessions would fail" : "this peon's Claude CLI is broken — sessions would fail",
          code: "AGENT_UNAVAILABLE",
          authState: blocked,
        });
      }
      const result = await callPeon(connOfRecord(c.record), "POST", "/sessions", {
        actor: c.operator.email,
        body: req.body,
        requestId: typeof requestId === "string" ? requestId : undefined,
      });
      const sessionId = acceptedSessionId(result);
      if (sessionId) {
        await recordSessionRequest({
          workspaceId: c.workspaceId,
          userId: c.userId,
          peonId: c.record.peonId,
          sessionId,
          occurrenceKey: `create:${typeof requestId === "string" ? requestId : sessionId}`,
        }).catch(() => undefined);
      }
      await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
      relay(result, res);
    }),
  );
  router.patch(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => relay(await callPeon(connOfRecord(c.record), "PATCH", `/sessions/${encodeURIComponent(String(req.params.sid))}`, { actor: c.operator.email, body: req.body }), res)));
  router.post(`${wp}/sessions/:sid/followup`, withWorkspaceSession(async (req, res, c) => {
    const commandId = req.headers["peon-request-id"];
    if (!validCommandId(commandId)) return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
    const sid = String(req.params.sid);
    const result = await runIdempotentFollowup(c.record.peonId, sid, commandId, req.body, () =>
      callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/followup`, { actor: c.operator.email, body: req.body, requestId: commandId }),
    );
    if (result.ok) {
      await recordSessionRequest({
        workspaceId: c.workspaceId,
        userId: c.userId,
        peonId: c.record.peonId,
        sessionId: sid,
        occurrenceKey: `followup:${commandId}`,
      }).catch(() => undefined);
    }
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
    relay(result, res);
  }));
  router.post(`${wp}/sessions/:sid/attention/read`, withWorkspaceSession(async (req, res, c) => {
    await markSessionAttentionRead(c.workspaceId, c.userId, c.record.peonId, String(req.params.sid));
    res.json({ ok: true });
  }));
  router.get(`${wp}/sessions/:sid/queue`, withWorkspaceSession(async (req, res, c) => {
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/queue`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/sessions/:sid/queue`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const result = await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/queue`, { actor: c.operator.email, body: req.body });
    const commandId = typeof req.body?.commandId === "string" ? req.body.commandId : null;
    if (result.ok && commandId) {
      await recordSessionRequest({ workspaceId: c.workspaceId, userId: c.userId, peonId: c.record.peonId, sessionId: sid, occurrenceKey: `queue:${commandId}` }).catch(() => undefined);
    }
    relay(result, res);
  }));
  router.post(`${wp}/sessions/:sid/queue/:itemId/send`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const result = await callPeon(
      connOfRecord(c.record),
      "POST",
      `/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(String(req.params.itemId))}/send`,
      { actor: c.operator.email },
    );
    if (result.ok) {
      const indexed = await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
      if (!indexed) {
        // Older Peons acknowledge the queue mutation without returning the
        // updated SessionRecord. Pull one authoritative summary so every open
        // Overseer client receives the running transition immediately.
        const snapshot = await callPeon(
          connOfRecord(c.record),
          "GET",
          `/sessions/${encodeURIComponent(sid)}`,
          { actor: c.operator.email },
        );
        await indexAcceptedSession(snapshot, c.workspaceId, c.record.peonId);
      }
    }
    relay(result, res);
  }));
  router.delete(`${wp}/sessions/:sid/queue/:itemId`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const itemId = String(req.params.itemId);
    const queue = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}/queue`, { actor: c.operator.email });
    const items = queue.ok && queue.json && typeof queue.json === "object" && Array.isArray((queue.json as { items?: unknown }).items)
      ? (queue.json as { items: Array<{ id?: unknown; commandId?: unknown }> }).items
      : [];
    const removedCommandId = items.find((item) => item.id === itemId)?.commandId;
    const result = await callPeon(
      connOfRecord(c.record),
      "DELETE",
      `/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(itemId)}`,
      { actor: c.operator.email },
    );
    if (result.ok && typeof removedCommandId === "string") await cancelSessionRequest(c.record.peonId, sid, `queue:${removedCommandId}`).catch(() => undefined);
    relay(result, res);
  }));
  // Stop is self-healing: a 409 SESSION_NOT_RUNNING means the operator pressed
  // Stop on a run that had already ended, so republish the Peon's authoritative
  // record and let the stale "running" state clear everywhere.
  router.post(`${wp}/sessions/:sid/cancel`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const result = await cancelSessionRun({
      cancel: () => callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/cancel`, { actor: c.operator.email }),
      snapshot: () => callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email }),
      publish: (snapshot) => indexAcceptedSession(snapshot, c.workspaceId, c.record.peonId),
    });
    relay(result, res);
  }));
  router.delete(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const result = await callPeon(connOfRecord(c.record), "DELETE", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email });
    if (result.ok) await deleteIndexedSession(c.workspaceId, c.record.peonId, sid);
    relay(result, res);
  }));
  router.post(`${wp}/control/pause`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/pause", { actor: c.operator.email }), res); }));
  router.post(`${wp}/control/resume`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/resume", { actor: c.operator.email }), res); }));
  router.post(`${wp}/control/check-update`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/check-update", { actor: c.operator.email }), res); }));
  router.post(`${wp}/control/update`, withWorkspacePeon(async (_req, res, c) => { if (!ownerOnly(res, c.role)) return; relay(await callPeon(connOfRecord(c.record), "POST", "/control/update", { actor: c.operator.email }), res); }));
  router.get(`${wp}/ai/cli-updates`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const query = req.query.refresh === "true" || req.query.refresh === "1" ? "?refresh=true" : "";
    const paths = ["/ai/cli-updates", "/ai/updates", "/cli-updates"].map((path) => `${path}${query}`);
    relay(await callSupportedPeonPath(c.record, "GET", paths, c.operator.email), res);
  }));
  router.post(`${wp}/ai/cli-updates/:provider`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    const provider = String(req.params.provider);
    if (provider !== "codex" && provider !== "claude-code") {
      return res.status(400).json({ error: "provider must be codex or claude-code", code: "BAD_PROVIDER" });
    }
    const encoded = encodeURIComponent(provider);
    const paths = [
      `/ai/cli-updates/${encoded}`,
      `/ai/cli-updates/${encoded}/update`,
      `/ai/updates/${encoded}`,
      `/ai/updates/${encoded}/update`,
      `/cli-updates/${encoded}`,
      `/cli-updates/${encoded}/update`,
    ];
    relay(await callSupportedPeonPath(c.record, "POST", paths, c.operator.email, req.body), res);
  }));
  router.get(`${wp}/sessions/:sid/stream`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const state = await getTranscriptState(c.record.peonId, sid);
    if (state?.epoch || hasReverseTranscriptConnection(c.record.peonId)) {
      return streamProjectedTranscript(req, res, c.record.peonId, sid, {
        workspaceId: c.workspaceId,
        userId: c.userId,
        role: c.role,
      });
    }
    return proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(sid)}/stream`, res, c.operator.email);
  }, { reverseTranscriptAcl: true }));

  // First-class session artifact previews. These deliberately mirror Peon's
  // session-scoped API instead of reusing the transfer sandbox: preview paths
  // may be absolute and Peon owns all path/session validation.
  router.get(`${wp}/sessions/:sid/file`, withWorkspaceSession(async (req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(String(req.params.sid))}/file?path=${encodeURIComponent(path)}`, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/sessions/:sid/file/raw`, withWorkspaceSession((req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    proxyGet(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/file/raw?path=${encodeURIComponent(path)}`, req, res, c.operator.email);
  }));
  router.get(`${wp}/sessions/:sid/file/stream`, withWorkspaceSession((req, res, c) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    proxyStream(connOfRecord(c.record), `/sessions/${encodeURIComponent(String(req.params.sid))}/file/stream?path=${encodeURIComponent(path)}`, res, c.operator.email);
  }));
  router.post(`${wp}/sessions/:sid/preview`, withWorkspaceSession(async (req, res, c) => {
    // callPeon maps the signed-in operator to Peon-Actor. The Peon persists and
    // broadcasts the returned normalized preview event.
    relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(String(req.params.sid))}/preview`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.post(`${wp}/sessions/:sid/web-preview`, withWorkspaceSession(async (req, res, c) => {
    const htmlPath = typeof req.body?.path === "string" ? req.body.path : "";
    try {
      res.status(201).json(mintWebPreview({
        peonId: c.record.peonId,
        workspaceId: c.record.workspaceId,
        sessionId: String(req.params.sid),
        htmlPath,
        actor: c.operator.email,
      }));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid HTML preview path", code: "BAD_PREVIEW_PATH" });
    }
  }));
}

async function streamProjectedTranscript(
  req: express.Request,
  res: express.Response,
  peonId: string,
  sessionId: string,
  access: {
    workspaceId: string;
    userId: string;
    role: Role;
  },
): Promise<void> {
  let release: () => void;
  try {
    if (!hasReverseTranscriptConnection(peonId)) {
      res.status(503).json({ error: "transcript stream is offline", code: "TRANSCRIPT_OFFLINE" });
      return;
    }
    release = await acquireTranscriptProjection(peonId, sessionId);
    if (!(await canAccessIndexedSessionNow(access.workspaceId, access.userId, peonId, sessionId))) {
      release();
      res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
      return;
    }
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "transcript stream unavailable",
      code: "TRANSCRIPT_UNAVAILABLE",
    });
    return;
  }
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const seen = new Set<string>();
  const writeEvent = (event: Record<string, unknown>): boolean =>
    writeProjectedTranscriptSseEvent(res, event, seen);
  let ready = false;
  let pendingBytes = 0;
  const pending: LiveEvent[] = [];
  let delivery = Promise.resolve();
  const deliver = async (live: LiveEvent): Promise<void> => {
    if (res.writableEnded || !live.payload || typeof live.payload !== "object") return;
    const payload = live.payload as {
      deleted?: unknown;
      event?: unknown;
      projectKey?: unknown;
      projectId?: unknown;
    };
    if (!(await canAccessIndexedSessionNow(access.workspaceId, access.userId, peonId, sessionId))) {
      res.end();
      return;
    }
    if (payload.deleted === true) {
      res.end();
      return;
    }
    if (payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)) {
      writeEvent(payload.event as Record<string, unknown>);
    }
  };
  const enqueue = (live: LiveEvent): void => {
    delivery = delivery.then(() => deliver(live)).catch(() => {
      if (!res.writableEnded) res.end();
    });
  };
  const onEvent = (live: LiveEvent) => {
    if (live.kind !== "transcript" || live.peonId !== peonId || live.sessionId !== sessionId) return;
    if (!ready) {
      const bytes = Buffer.byteLength(JSON.stringify(live.payload));
      if (pending.length >= 1_000 || pendingBytes + bytes > 8 * 1024 * 1024) {
        res.end();
        return;
      }
      pending.push(live);
      pendingBytes += bytes;
      return;
    }
    enqueue(live);
  };
  bus.on("event", onEvent);
  try {
    const lastEventId = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null;
    const replay = await readTranscriptAfter({ peonId, sessionId, lastEventId });
    for (const event of replay) {
      if (!(await canAccessIndexedSessionNow(access.workspaceId, access.userId, peonId, sessionId))) {
        res.end();
        break;
      }
      if (!writeEvent(event)) break;
    }
    for (const live of pending.sort((left, right) => left.cursor - right.cursor)) enqueue(live);
    pending.length = 0;
    pendingBytes = 0;
    ready = true;
    await new Promise<void>((resolve) => {
      req.once("close", resolve);
      res.once("close", resolve);
    });
  } finally {
    bus.off("event", onEvent);
    release();
  }
}

export function writeProjectedTranscriptSseEvent(
  res: Pick<express.Response, "writableEnded" | "writableLength" | "write" | "end">,
  event: Record<string, unknown>,
  seen: Set<string>,
): boolean {
  const eventId = typeof event.eventId === "string" ? event.eventId : null;
  if (!eventId || res.writableEnded) return false;
  if (seen.has(eventId)) return true;
  seen.add(eventId);
  if (res.writableLength > 8 * 1024 * 1024) {
    res.end();
    return false;
  }
  const accepted = res.write(`event: event\nid: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`);
  if (!accepted) res.end();
  return accepted;
}

// Ask a peon's /status whether its legacy/default Claude CLI is usable. Explicit
// non-Claude providers have their own runtime and must not be blocked by this
// provider-specific status field. Returns the offending
// authState ("broken" | "unauthenticated") when new work must NOT be routed there,
// or null when it's fine to proceed — including when we can't tell (peon
// unreachable, no agentAuth field on an older peon, or authState "unknown").
async function agentAuthBlocked(record: PeonRecord, agent: unknown): Promise<"broken" | "unauthenticated" | null> {
if (typeof agent === "string" && agent !== "claude-code") return null;
const r = await callPeon(connOfRecord(record), "GET", "/status");
if (!r.ok || !r.json || typeof r.json !== "object") return null;
const auth = (r.json as { agentAuth?: unknown }).agentAuth;
const state = auth && typeof auth === "object" ? (auth as { authState?: unknown }).authState : undefined;
return state === "broken" || state === "unauthenticated" ? state : null;
}
