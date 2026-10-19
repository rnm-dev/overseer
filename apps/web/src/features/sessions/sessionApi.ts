import { api, json } from "../../shared/api";

// Typed helpers for the per-session Peon endpoints.

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

export function withRequestId(body: unknown, requestId: string): RequestInit {
  const request = json(body);
  request.headers = { "Peon-Request-Id": requestId };
  return request;
}
