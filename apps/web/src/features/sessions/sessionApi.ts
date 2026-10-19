import { api, json } from "../../shared/api";
import type { MentionPrincipal } from "./contextMentions";

// Typed wrappers for the per-session Peon endpoints this page calls directly.

export interface SessionRecord {
  title?: string | null;
  prompt?: string | null;
  promptPreview?: string | null;
  projectKey?: string | null;
  projectId?: string | null;
  projectRoot?: string | null;
  status?: string | null;
  agent?: string | null;
  backendSessionId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  permissionMode?: string | null;
  turnCount?: number | null;
  usage?: unknown;
  branchedFromSessionId?: string | null;
  parentSessionId?: string | null;
}

export function sessionPath(base: string, sid: string, suffix = ""): string {
  return `${base}/sessions/${encodeURIComponent(sid)}${suffix}`;
}

export function getSession(base: string, sid: string): Promise<SessionRecord> {
  return api<SessionRecord>(sessionPath(base, sid));
}

export function renameSession(base: string, sid: string, title: string | null): Promise<unknown> {
  return api(sessionPath(base, sid), { method: "PATCH", body: JSON.stringify({ title }) });
}

export function deleteSession(base: string, sid: string): Promise<unknown> {
  return api(sessionPath(base, sid), { method: "DELETE" });
}

export function cancelSession(base: string, sid: string): Promise<unknown> {
  return api(sessionPath(base, sid, "/cancel"), { method: "POST" });
}

export function markSessionAttentionRead(base: string, sid: string): Promise<unknown> {
  return api(sessionPath(base, sid, "/attention/read"), { method: "POST" });
}

export function getMentionPrincipals(base: string, sid: string): Promise<{ principals?: MentionPrincipal[] }> {
  return api<{ principals?: MentionPrincipal[] }>(sessionPath(base, sid, "/mention-principals"));
}

export function getMentionAttention(base: string, sid: string): Promise<{ attention?: Array<{ eventId: string; unread: boolean }> }> {
  return api<{ attention?: Array<{ eventId: string; unread: boolean }> }>(sessionPath(base, sid, "/mention-attention"));
}

export function markMentionAttentionRead(base: string, sid: string, eventIds: string[]): Promise<unknown> {
  return api(sessionPath(base, sid, "/mention-attention/read"), { method: "POST", body: JSON.stringify({ eventIds }) });
}

function withRequestId(body: unknown, requestId: string): RequestInit {
  const request = json(body);
  request.headers = { "Peon-Request-Id": requestId };
  return request;
}

export function postFollowup(base: string, sid: string, body: unknown, requestId: string): Promise<unknown> {
  return api(sessionPath(base, sid, "/followup"), withRequestId(body, requestId));
}

export function postContextMessage(base: string, sid: string, body: unknown, requestId: string): Promise<unknown> {
  return api(sessionPath(base, sid, "/context-messages"), withRequestId(body, requestId));
}
