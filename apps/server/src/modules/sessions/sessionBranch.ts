import {
  callPeon,
  type PeonCallResult,
  type PeonConn,
} from "../../infrastructure/peonHttp/index.js";
import { indexAcceptedSession } from "./acceptedSessionService.js";

export interface BranchSessionInput {
  conn: PeonConn;
  workspaceId: string;
  userId: string;
  peonId: string;
  sessionId: string;
  actor: string;
  requestId: string;
  body: unknown;
  recordRequest: (input: {
    workspaceId: string;
    userId: string;
    peonId: string;
    sessionId: string;
    occurrenceKey: string;
  }) => Promise<unknown>;
}

interface BranchSessionDeps {
  call: typeof callPeon;
  index: typeof indexAcceptedSession;
}

const defaultDeps: BranchSessionDeps = {
  call: callPeon,
  index: indexAcceptedSession,
};

function acceptedSessionId(result: Pick<PeonCallResult, "ok" | "json">): string | null {
  if (!result.ok || !result.json || typeof result.json !== "object") return null;
  const body = result.json as Record<string, unknown>;
  if (typeof body.id === "string") return body.id;
  return body.session && typeof body.session === "object"
    && typeof (body.session as Record<string, unknown>).id === "string"
    ? String((body.session as Record<string, unknown>).id)
    : null;
}

export async function branchSession(
  input: BranchSessionInput,
  deps: BranchSessionDeps = defaultDeps,
): Promise<PeonCallResult> {
  const result = await deps.call(
    input.conn,
    "POST",
    `/sessions/${encodeURIComponent(input.sessionId)}/branch`,
    { actor: input.actor, body: input.body, requestId: input.requestId },
  );
  const branchedSessionId = acceptedSessionId(result);
  if (branchedSessionId) {
    await input.recordRequest({
      workspaceId: input.workspaceId,
      userId: input.userId,
      peonId: input.peonId,
      sessionId: branchedSessionId,
      occurrenceKey: `branch:${input.requestId}`,
    }).catch(() => undefined);
  }
  await deps.index(result, input.workspaceId, input.peonId);
  return result;
}
