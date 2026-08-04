import { api } from "../../../api";

export interface SessionLineageRecord {
  branchedFromSessionId?: string | null;
  parentSessionId?: string | null;
}

export interface SessionLineage {
  sourceSessionId: string;
  relation: "branch" | "subsession";
}

export function sessionLineage(record: SessionLineageRecord): SessionLineage | null {
  if (record.branchedFromSessionId) return { sourceSessionId: record.branchedFromSessionId, relation: "branch" };
  if (record.parentSessionId) return { sourceSessionId: record.parentSessionId, relation: "subsession" };
  return null;
}

export function createSessionBranch(base: string, sessionId: string, requestId: string = crypto.randomUUID()): Promise<{ id: string }> {
  return api<{ id: string }>(`${base}/sessions/${encodeURIComponent(sessionId)}/branch`, {
    method: "POST",
    headers: { "Peon-Request-Id": requestId },
    body: JSON.stringify({}),
  });
}
