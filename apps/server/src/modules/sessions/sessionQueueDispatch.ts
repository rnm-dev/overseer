import {
  callPeon,
  type PeonCallResult,
  type PeonConn,
} from "../../infrastructure/peonHttp/index.js";
import { indexAcceptedSession } from "./acceptedSessionService.js";

export interface DispatchQueuedSessionItemInput {
  conn: PeonConn;
  workspaceId: string;
  peonId: string;
  sessionId: string;
  itemId: string;
  actor: string;
  operation: "steer" | "send";
}

interface DispatchQueuedSessionItemDeps {
  call: typeof callPeon;
  index: typeof indexAcceptedSession;
}

const defaultDeps: DispatchQueuedSessionItemDeps = {
  call: callPeon,
  index: indexAcceptedSession,
};

export async function dispatchQueuedSessionItem(
  input: DispatchQueuedSessionItemInput,
  deps: DispatchQueuedSessionItemDeps = defaultDeps,
): Promise<PeonCallResult> {
  const sessionPath = `/sessions/${encodeURIComponent(input.sessionId)}`;
  const result = await deps.call(
    input.conn,
    "POST",
    `${sessionPath}/queue/${encodeURIComponent(input.itemId)}/${input.operation}`,
    { actor: input.actor },
  );
  if (result.ok) {
    const indexed = await deps.index(result, input.workspaceId, input.peonId);
    if (!indexed) {
      // Older Peons acknowledge this mutation without returning the updated
      // SessionRecord. Repair the projection from one authoritative snapshot.
      const snapshot = await deps.call(input.conn, "GET", sessionPath, { actor: input.actor });
      await deps.index(snapshot, input.workspaceId, input.peonId);
    }
  }
  return result;
}
