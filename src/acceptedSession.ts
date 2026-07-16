import type { PeonCallResult } from "./peonClient.js";
import { upsertSession } from "./sessionIndex.js";

type SessionWriter = typeof upsertSession;

// Successful session creation and follow-up responses contain the Peon's
// authoritative SessionRecord. Publish it immediately instead of making the
// operator UI wait for the Peon's asynchronous event-push/reconcile cycle.
// Indexing is deliberately best-effort: the Peon already accepted the command,
// so a local cache failure must not turn success into a misleading HTTP error.
export async function indexAcceptedSession(
  result: Pick<PeonCallResult, "ok" | "json">,
  workspaceId: string,
  peonId: string,
  write: SessionWriter = upsertSession,
): Promise<void> {
  if (!result.ok || !result.json || typeof result.json !== "object") return;
  const body = result.json as Record<string, unknown>;
  const session = typeof body.id === "string"
    ? body
    : body.session && typeof body.session === "object" && typeof (body.session as Record<string, unknown>).id === "string"
      ? body.session as Record<string, unknown>
      : null;
  if (!session) return;
  try {
    await write(workspaceId, peonId, session as unknown as Parameters<SessionWriter>[2]);
  } catch {
    // The normal Peon event push and periodic reconcile remain the backstop.
  }
}
