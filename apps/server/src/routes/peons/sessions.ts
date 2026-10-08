import { deleteSessionPins, listMessagePins, pinMessage, unpinMessage, validPinEventId } from "../../modules/sessions/index.js";
import express from "express";
import type { PeonRecord } from "../../modules/fleet/index.js";
import { callPeon, connOfRecord, proxyGet, proxyStream } from "../../infrastructure/peonHttp/index.js";
import {
  allowedProjects,
  canAccessIndexedSessionNow,
  canAccessProject,
} from "../../modules/access/index.js";
import { ownerOnly, relay, withWorkspacePeon } from "../requestContext.js";
import { PreviewsDisabledError, mintWebPreview } from "../webPreview.js";
import { runIdempotentFollowup, validCommandId } from "../../modules/sessions/index.js";
import {
  CONTEXT_MESSAGES_CAPABILITY,
  ContextMessageError,
  authorPrincipal,
  deleteMentionAttention,
  listMentionAttention,
  markMentionAttentionRead,
  mentionPrincipals,
  recordMentionAttention,
  resolveMentions,
  validateContextAttachments,
  validateContextText,
  validContextCommandId,
} from "../../modules/sessions/index.js";
import { enrichTranscriptMetadata } from "../../modules/sessions/index.js";
import { deleteIndexedSession, getIndexedSession } from "../../modules/sessions/index.js";
import { cancelSessionRequest, markSessionAttentionRead, recordSessionRequest } from "../../modules/sessions/index.js";
import { getIndexedProject, getIndexedProjectById } from "../../modules/projects/index.js";
import {
  cancelSessionRun,
  branchSession,
  dispatchQueuedSessionItem,
  indexAcceptedSession,
} from "../../modules/sessions/index.js";

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
  ) => withWorkspacePeon(async (req, res, c) => {
    if (!c.participant && c.role !== "owner") {
      const sid = String(req.params.sid);
      const indexed = await getIndexedSession(c.record.peonId, sid);
      let projectKey = indexed?.projectKey ?? null;
      let projectId = indexed?.projectId ?? null;
      if (!indexed) {
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
  const contextFailure = (error: unknown, res: express.Response): boolean => {
    if (!(error instanceof ContextMessageError)) return false;
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  };
  const requireContextCapability = (record: PeonRecord, res: express.Response): boolean => {
    if (record.capabilities.includes(CONTEXT_MESSAGES_CAPABILITY)) return true;
    res.status(409).json({ error: "this Peon does not support context-only participant messages", code: "UNSUPPORTED_CAPABILITY" });
    return false;
  };
  const normalizeAgentMessage = async (
    body: unknown,
    c: Parameters<Parameters<typeof withWorkspacePeon>[0]>[2],
    sid: string,
    nullable = false,
  ): Promise<unknown> => {
    if (!body || typeof body !== "object" || Array.isArray(body) || !("mentions" in body)) return body;
    if (!c.record.capabilities.includes(CONTEXT_MESSAGES_CAPABILITY)) {
      throw new ContextMessageError("this Peon does not support structured mentions", "UNSUPPORTED_CAPABILITY", 409);
    }
    const source = body as Record<string, unknown>;
    const text = typeof source.prompt === "string" ? source.prompt : "";
    return {
      ...source,
      authorPrincipal: authorPrincipal(c),
      mentions: await resolveMentions(c.workspaceId, c.record.peonId, sid, text, source.mentions, nullable),
    };
  };
  // Pins are session annotations. The snapshot comes from Peon, never the client.
  router.get(`${wp}/sessions/:sid/pins`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    if (!c.participant && !(await canAccessIndexedSessionNow(c.workspaceId, c.userId, c.record.peonId, sid))) return res.status(404).json({ error: "unknown session" });
    res.json({ pins: await listMessagePins(c.workspaceId, c.record.peonId, sid) });
  }));
  router.put(`${wp}/sessions/:sid/pins/:eventId`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid), eventId = String(req.params.eventId);
    if (!c.participant && !(await canAccessIndexedSessionNow(c.workspaceId, c.userId, c.record.peonId, sid))) return res.status(404).json({ error: "unknown session" });
    if (!validPinEventId(eventId)) return res.status(400).json({ error: "invalid event id" });
    const result = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}/transcript`, { actor: c.operator.email });
    if (!result.ok) return relay(result, res);
    const events = (result.json as { events?: Array<Record<string, unknown>> })?.events;
    const event = events?.find((item) => item.eventId === eventId);
    if (!event) return res.status(404).json({ error: "message not found" });
    if (!["user_message", "participant_message", "assistant", "result"].includes(String(event.type))) return res.status(400).json({ error: "this event cannot be pinned" });
    const [snapshot] = await enrichTranscriptMetadata(c.record.peonId, sid, [event]);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 131072) return res.status(413).json({ error: "message is too large to pin" });
    if (!(await pinMessage(c.workspaceId, c.record.peonId, sid, eventId, snapshot, c.operator.githubLogin || c.operator.email))) return res.status(409).json({ error: "maximum 50 pins per session" });
    res.json({ pins: await listMessagePins(c.workspaceId, c.record.peonId, sid) });
  }));
  router.delete(`${wp}/sessions/:sid/pins/:eventId`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    if (!c.participant && !(await canAccessIndexedSessionNow(c.workspaceId, c.userId, c.record.peonId, sid))) return res.status(404).json({ error: "unknown session" });
    await unpinMessage(c.workspaceId, c.record.peonId, sid, String(req.params.eventId));
    res.json({ pins: await listMessagePins(c.workspaceId, c.record.peonId, sid) });
  }));
  router.get(`${wp}/status`, withWorkspacePeon(async (_req, res, c) => {
    relay(await callPeon(connOfRecord(c.record), "GET", "/status", { actor: c.operator.email }), res);
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
    const sid = String(req.params.sid);
    const result = await callPeon(connOfRecord(c.record), "GET", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email });
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
  router.get(`${wp}/sessions/:sid/inquiries`, withWorkspaceSession(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    const sid = encodeURIComponent(String(req.params.sid));
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${sid}/inquiries`, { actor: c.operator.email }), res);
  }));
  router.get(`${wp}/sessions/:sid/inquiries/:inquiryId`, withWorkspaceSession(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    const sid = encodeURIComponent(String(req.params.sid));
    const inquiryId = encodeURIComponent(String(req.params.inquiryId));
    relay(await callPeon(connOfRecord(c.record), "GET", `/sessions/${sid}/inquiries/${inquiryId}`, { actor: c.operator.email }), res);
  }));
  router.post(`${wp}/sessions/:sid/inquiries/:inquiryId/respond`, withWorkspaceSession(async (req, res, c) => {
    res.setHeader("Cache-Control", "no-store");
    const action = req.body?.action;
    if (action !== "install" && action !== "cancel") return res.status(400).json({ error: "action must be install or cancel", code: "BAD_REQUEST" });
    const sid = encodeURIComponent(String(req.params.sid));
    const inquiryId = encodeURIComponent(String(req.params.inquiryId));
    relay(await callPeon(connOfRecord(c.record), "POST", `/sessions/${sid}/inquiries/${inquiryId}/respond`, {
      actor: c.operator.email,
      body: { action },
    }), res);
  }));
  router.get(`${wp}/sessions/:sid/transcript`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    if (!c.participant && !(await canAccessIndexedSessionNow(c.workspaceId, c.userId, c.record.peonId, sid))) {
      return res.status(404).json({ error: "unknown session", code: "UNKNOWN_SESSION" });
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
          if (c.record.capabilities.includes(CONTEXT_MESSAGES_CAPABILITY)) {
            await Promise.all(events.map((event) => recordMentionAttention(c.workspaceId, c.record.peonId, sid, event)));
          }
          return res.status(r.status).json({ ...body, events });
        } catch {
          // Local metadata enrichment is best-effort; never hide a valid transcript
          // because its local metadata could not be read.
        }
      }
    }
    relay(r, res);
  }));
  router.get(`${wp}/sessions/:sid/mention-principals`, withWorkspaceSession(async (req, res, c) => {
    if (!requireContextCapability(c.record, res)) return;
    res.json({ principals: await mentionPrincipals(c.workspaceId, c.record.peonId, String(req.params.sid)) });
  }));
  router.get(`${wp}/sessions/:sid/mention-attention`, withWorkspaceSession(async (req, res, c) => {
    if (!requireContextCapability(c.record, res)) return;
    res.json({ attention: await listMentionAttention(
      c.workspaceId, c.record.peonId, String(req.params.sid), authorPrincipal(c),
    ) });
  }));
  router.post(`${wp}/sessions/:sid/mention-attention/read`, withWorkspaceSession(async (req, res, c) => {
    if (!requireContextCapability(c.record, res)) return;
    try {
      await markMentionAttentionRead(
        c.workspaceId, c.record.peonId, String(req.params.sid), authorPrincipal(c), req.body?.eventIds,
      );
      res.json({ ok: true });
    } catch (error) {
      if (!contextFailure(error, res)) throw error;
    }
  }));
  router.post(`${wp}/sessions/:sid/context-messages`, withWorkspaceSession(async (req, res, c) => {
    if (!requireContextCapability(c.record, res)) return;
    const commandId = req.headers["peon-request-id"];
    if (!validContextCommandId(commandId)) return res.status(400).json({ error: "Peon-Request-Id must be a valid command id", code: "BAD_CONTEXT_MESSAGE" });
    try {
      const sid = String(req.params.sid);
      const text = validateContextText(req.body?.text);
      const body = {
        text,
        author: authorPrincipal(c),
        attachments: validateContextAttachments(req.body?.attachments),
        mentions: await resolveMentions(c.workspaceId, c.record.peonId, sid, text, req.body?.mentions),
      };
      const result = await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/context-messages`, {
        actor: c.operator.email, body, requestId: commandId,
      });
      if (result.ok) await recordMentionAttention(c.workspaceId, c.record.peonId, sid, result.json);
      relay(result, res);
    } catch (error) {
      if (!contextFailure(error, res)) throw error;
    }
  }));
  router.post(
    `${wp}/sessions`,
    withWorkspacePeon(async (req, res, c) => {
      const projectKey = typeof req.body?.projectKey === "string" ? req.body.projectKey : null;
      const requestId = req.headers["peon-request-id"];
      if (requestId !== undefined && !validCommandId(requestId)) {
        return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
      }
      const indexedProject = projectKey ? await getIndexedProject(c.record.peonId, projectKey) : null;
      let projectId: string | null = indexedProject?.projectId ?? null;
      if (projectKey && !projectId && c.role !== "owner") {
        const project = await callPeon(connOfRecord(c.record), "GET", `/projects/${encodeURIComponent(projectKey)}`, { actor: c.operator.email });
        projectId = project.ok && project.json && typeof project.json === "object" && typeof (project.json as { projectId?: unknown }).projectId === "string"
          ? (project.json as { projectId: string }).projectId
          : null;
      }
      if (projectKey && !(await canAccessProject(c.workspaceId, c.userId, c.role, c.record.peonId, projectKey, projectId))) return res.status(403).json({ error: "project access required", code: "FORBIDDEN" });
      // Control plane owns admission (PROTOCOL: "control plane owns admission"). A
      // peon can be online yet have a broken/unauthenticated Claude CLI — it would
      // accept the session and then fail every run. Refuse to route new work there.
      // Older peons that don't report agentAuth (or report "unknown") pass through:
      // we only block on a definitively bad CLI so un-upgraded peons keep working.
      const blocked = await agentAuthBlocked(c.record, req.body?.agent, req.body?.model);
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
  router.patch(`${wp}/sessions/:sid`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    relay(await callPeon(connOfRecord(c.record), "PATCH", `/sessions/${encodeURIComponent(sid)}`, { actor: c.operator.email, body: req.body }), res);
  }));
  router.post(`${wp}/sessions/:sid/branch`, withWorkspaceSession(async (req, res, c) => {
    const requestId = req.headers["peon-request-id"];
    if (!validCommandId(requestId)) return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
    const sid = String(req.params.sid);
    const result = await branchSession({
      conn: connOfRecord(c.record),
      workspaceId: c.workspaceId,
      userId: c.userId,
      peonId: c.record.peonId,
      sessionId: sid,
      actor: c.operator.email,
      requestId,
      body: req.body,
      recordRequest: recordSessionRequest,
    });
    relay(result, res);
  }));
  router.post(`${wp}/sessions/:sid/followup`, withWorkspaceSession(async (req, res, c) => {
    const commandId = req.headers["peon-request-id"];
    if (!validCommandId(commandId)) return res.status(400).json({ error: "Peon-Request-Id must be a non-empty idempotency key of at most 255 characters", code: "BAD_REQUEST" });
    const sid = String(req.params.sid);
    let body: unknown;
    try { body = await normalizeAgentMessage(req.body, c, sid); } catch (error) {
      if (contextFailure(error, res)) return;
      throw error;
    }
    const result = await runIdempotentFollowup(c.record.peonId, sid, commandId, body, () =>
      callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/followup`, { actor: c.operator.email, body, requestId: commandId }),
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
    const commandId = typeof req.body?.commandId === "string" ? req.body.commandId : null;
    let body: unknown;
    try { body = await normalizeAgentMessage(req.body, c, sid); } catch (error) {
      if (contextFailure(error, res)) return;
      throw error;
    }
    const result = await callPeon(connOfRecord(c.record), "POST", `/sessions/${encodeURIComponent(sid)}/queue`, { actor: c.operator.email, body });
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
    if (result.ok && commandId) {
      await recordSessionRequest({ workspaceId: c.workspaceId, userId: c.userId, peonId: c.record.peonId, sessionId: sid, occurrenceKey: `queue:${commandId}` }).catch(() => undefined);
    }
    relay(result, res);
  }));
  router.post(`${wp}/sessions/:sid/queue/:itemId/steer`, withWorkspaceSession(async (req, res, c) => {
    const result = await dispatchQueuedSessionItem({
      conn: connOfRecord(c.record),
      workspaceId: c.workspaceId,
      peonId: c.record.peonId,
      sessionId: String(req.params.sid),
      itemId: String(req.params.itemId),
      actor: c.operator.email,
      operation: "steer",
    });
    relay(result, res);
  }));
  router.post(`${wp}/sessions/:sid/queue/:itemId/send`, withWorkspaceSession(async (req, res, c) => {
    res.set("Deprecation", "true");
    res.set("Link", `<${req.baseUrl}${req.path.replace(/\/send$/, "/steer")}>; rel="successor-version"`);
    const result = await dispatchQueuedSessionItem({
      conn: connOfRecord(c.record),
      workspaceId: c.workspaceId,
      peonId: c.record.peonId,
      sessionId: String(req.params.sid),
      itemId: String(req.params.itemId),
      actor: c.operator.email,
      operation: "send",
    });
    relay(result, res);
  }));
  router.patch(`${wp}/sessions/:sid/queue/:itemId`, withWorkspaceSession(async (req, res, c) => {
    const sid = String(req.params.sid);
    const itemId = String(req.params.itemId);
    let body: unknown;
    try { body = await normalizeAgentMessage(req.body, c, sid, true); } catch (error) {
      if (contextFailure(error, res)) return;
      throw error;
    }
    const result = await callPeon(
      connOfRecord(c.record), "PATCH",
      `/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(itemId)}`,
      { actor: c.operator.email, body },
    );
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
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
    if (result.ok) {
      await deleteMentionAttention(c.record.peonId, sid);
      await deleteSessionPins(c.workspaceId, c.record.peonId, sid);
      await deleteIndexedSession(c.workspaceId, c.record.peonId, sid);
    }
    relay(result, res);
  }));
  router.post(`${wp}/control/check-update`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(connOfRecord(c.record), "POST", "/control/check-update", {
      actor: c.operator.email,
      timeoutMs: 35_000,
    }), res);
  }));
  router.post(`${wp}/control/update`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(connOfRecord(c.record), "POST", "/control/update", {
      actor: c.operator.email,
      body: req.body?.force === true ? { force: true } : {},
      timeoutMs: 5_000,
    }), res);
  }));
  router.get(`${wp}/control/update/:requestId`, withWorkspacePeon(async (req, res, c) => {
    if (!ownerOnly(res, c.role)) return;
    relay(await callPeon(
      connOfRecord(c.record),
      "GET",
      `/control/update/${encodeURIComponent(String(req.params.requestId))}`,
      { actor: c.operator.email },
    ), res);
  }));
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
    const candidate = req.headers["last-event-id"];
    const lastEventId = typeof candidate === "string"
      && candidate.length <= 256
      && /^[A-Za-z0-9_-]+$/.test(candidate)
      ? candidate
      : null;
    return proxyStream(
      connOfRecord(c.record),
      `/sessions/${encodeURIComponent(sid)}/stream`,
      res,
      c.operator.email,
      lastEventId,
      c.record.capabilities.includes(CONTEXT_MESSAGES_CAPABILITY)
        ? (event) => recordMentionAttention(c.workspaceId, c.record.peonId, sid, event)
        : null,
    );
  }));

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
        userId: c.userId,
      }));
    } catch (err) {
      // A disabled feature is not a bad request: the path may be perfectly good.
      if (err instanceof PreviewsDisabledError) {
        res.status(503).json({ error: err.message, code: "PREVIEWS_DISABLED" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : "invalid HTML preview path", code: "BAD_PREVIEW_PATH" });
    }
  }));
}

// Ask a peon's /status whether its legacy/default Claude CLI is usable. Explicit
// non-Claude providers have their own runtime and must not be blocked by this
// provider-specific status field. Returns the offending
// authState ("broken" | "unauthenticated") when new work must NOT be routed there,
// or null when it's fine to proceed — including when we can't tell (peon
// unreachable, no agentAuth field on an older peon, or authState "unknown").
export function effectiveAgentForAdmission(catalog: unknown, agent: unknown, model: unknown): string | null {
  if (typeof agent === "string" && agent) return agent;
  if (!catalog || typeof catalog !== "object") return null;
  const body = catalog as { defaultAgent?: unknown; providers?: unknown };
  if (typeof model === "string" && Array.isArray(body.providers)) {
    for (const provider of body.providers) {
      if (!provider || typeof provider !== "object") continue;
      const candidate = provider as { agent?: unknown; models?: unknown };
      if (typeof candidate.agent !== "string" || !Array.isArray(candidate.models)) continue;
      const matches = candidate.models.some((entry) => entry && typeof entry === "object"
        && ((entry as { id?: unknown }).id === model || (entry as { alias?: unknown }).alias === model));
      if (matches) return candidate.agent;
    }
  }
  return typeof body.defaultAgent === "string" ? body.defaultAgent : null;
}

export async function agentAuthBlocked(record: PeonRecord, agent: unknown, model: unknown): Promise<"broken" | "unauthenticated" | null> {
  let effectiveAgent = typeof agent === "string" && agent ? agent : null;
  if (!effectiveAgent) {
    const catalog = await callPeon(connOfRecord(record), "GET", "/models");
    effectiveAgent = effectiveAgentForAdmission(catalog.ok ? catalog.json : null, agent, model);
  }
  if (effectiveAgent && effectiveAgent !== "claude-code") return null;
  const r = await callPeon(connOfRecord(record), "GET", "/status");
  if (!r.ok || !r.json || typeof r.json !== "object") return null;
  const auth = (r.json as { agentAuth?: unknown }).agentAuth;
  const state = auth && typeof auth === "object" ? (auth as { authState?: unknown }).authState : undefined;
  return state === "broken" || state === "unauthenticated" ? state : null;
}
