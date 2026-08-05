import { appendEvent } from "../../infrastructure/events/index.js";
import { query, transaction } from "../../infrastructure/db/index.js";
import { cancelPendingPush } from "../../infrastructure/push/index.js";
import { isUserViewingSession } from "../presence/index.js";
import type { SessionAttentionPayload } from "./sessionAttentionTypes.js";
export type { SessionAttentionPayload } from "./sessionAttentionTypes.js";

export interface SessionAttentionProjection {
  unread: boolean;
  hasOutstandingRequest: boolean;
  lastRequestedAt: number | null;
  updatedAt: number;
}

// The operator-scoped projection of one session, recomputed from committed rows.
// `state` carries read acknowledgement, `resolved_at` carries run lifecycle; a
// session the operator opened mid-run is read *and* still outstanding.
export async function sessionAttentionProjection(
  workspaceId: string,
  userId: string,
  peonId: string,
  sessionId: string,
): Promise<SessionAttentionProjection | null> {
  const { rows } = await query<{ state: string; requested_at: number | string; completed_at: number | string | null; read_at: number | string | null; resolved_at: number | string | null }>(
    `SELECT state, requested_at, completed_at, read_at, resolved_at FROM session_attention
     WHERE workspace_id=$1 AND user_id=$2 AND peon_id=$3 AND session_id=$4`,
    [workspaceId, userId, peonId, sessionId],
  );
  if (rows.length === 0) return null;
  let unread = false;
  let hasOutstandingRequest = false;
  let lastRequestedAt = 0;
  let updatedAt = 0;
  for (const row of rows) {
    const requestedAt = Number(row.requested_at);
    if (row.state === "unread") unread = true;
    if (row.resolved_at === null) hasOutstandingRequest = true;
    lastRequestedAt = Math.max(lastRequestedAt, requestedAt);
    updatedAt = Math.max(updatedAt, requestedAt, Number(row.completed_at ?? 0), Number(row.read_at ?? 0), Number(row.resolved_at ?? 0));
  }
  return { unread, hasOutstandingRequest, lastRequestedAt, updatedAt };
}

// Publish the operator-scoped projection so a mobile cache can update without
// polling. `eventVisible` scopes attention events to `payload.userId`, so this
// never reaches another operator's socket.
async function publishAttention(
  workspaceId: string,
  userId: string,
  peonId: string,
  sessionId: string,
  completedAt: number | null,
  fallbackUpdatedAt: number,
): Promise<void> {
  const projection = await sessionAttentionProjection(workspaceId, userId, peonId, sessionId);
  await appendEvent({
    workspaceId,
    peonId,
    sessionId,
    kind: "attention",
    payload: {
      userId,
      peonId,
      sessionId,
      unread: projection?.unread ?? false,
      hasOutstandingRequest: projection?.hasOutstandingRequest ?? false,
      lastRequestedAt: projection?.lastRequestedAt ?? null,
      completedAt,
      updatedAt: projection?.updatedAt || fallbackUpdatedAt,
    } satisfies SessionAttentionPayload,
  });
}

export async function recordSessionRequest(input: {
  workspaceId: string;
  userId: string;
  peonId: string;
  sessionId: string;
  occurrenceKey: string;
  requestedAt?: number;
}): Promise<void> {
  const requestedAt = input.requestedAt ?? Date.now();
  await query(
    `INSERT INTO session_attention
       (workspace_id, user_id, peon_id, session_id, occurrence_key, state, requested_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6)
     ON CONFLICT (user_id, peon_id, session_id, occurrence_key) DO NOTHING`,
    [input.workspaceId, input.userId, input.peonId, input.sessionId, input.occurrenceKey, requestedAt],
  );
  // An accepted request is the first half of the operator's request lifecycle;
  // the mobile list needs it immediately, before anything completes.
  await publishAttention(input.workspaceId, input.userId, input.peonId, input.sessionId, null, requestedAt);
}

export async function completeNextSessionAttention(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  completedAt: number,
): Promise<void> {
  const touched = await transaction(async (tx) => {
    const users: string[] = [];
    // Lifecycle first, and on its own queue: a run that finishes closes the
    // oldest request still in flight, whether or not its requester has already
    // opened the session. Read acknowledgement must never leave a request
    // outstanding forever.
    const unresolved = await tx.query<{ user_id: string; occurrence_key: string }>(
      `SELECT user_id, occurrence_key FROM session_attention
       WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3 AND resolved_at IS NULL
       ORDER BY requested_at ASC, occurrence_key ASC LIMIT 1`,
      [workspaceId, peonId, sessionId],
    );
    const oldest = unresolved.rows[0];
    if (oldest) {
      await tx.query(
        `UPDATE session_attention SET resolved_at=$5
         WHERE user_id=$1 AND peon_id=$2 AND session_id=$3 AND occurrence_key=$4 AND resolved_at IS NULL`,
        [oldest.user_id, peonId, sessionId, oldest.occurrence_key, completedAt],
      );
      users.push(oldest.user_id);
    }

    // Notification second, on its own queue. Only a still-pending occurrence can
    // become unread. An occurrence the user already viewed is terminal for the
    // amber edge, and it must not sit at the head of the queue soaking up the
    // completions that belong to later requests.
    const pending = await tx.query<{ user_id: string; occurrence_key: string }>(
      `SELECT user_id, occurrence_key FROM session_attention
       WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3 AND state='pending' AND completed_at IS NULL
       ORDER BY requested_at ASC LIMIT 1`,
      [workspaceId, peonId, sessionId],
    );
    const next = pending.rows[0];
    if (!next) return users;
    // Attention means "this finished while you were not looking". If the requester
    // is in front of this very session, the occurrence is already seen: retire it
    // as read so no unread edge appears on the session they are sitting in.
    const seen = isUserViewingSession(workspaceId, next.user_id, peonId, sessionId);
    const updated = await tx.query<{ user_id: string }>(
      seen
        ? `UPDATE session_attention SET state='read', completed_at = $5, read_at = $5
       WHERE user_id=$1 AND peon_id=$2 AND session_id=$3 AND occurrence_key=$4
         AND state='pending' AND completed_at IS NULL
       RETURNING user_id`
        : `UPDATE session_attention SET state='unread', completed_at = $5
       WHERE user_id=$1 AND peon_id=$2 AND session_id=$3 AND occurrence_key=$4
         AND state='pending' AND completed_at IS NULL
       RETURNING user_id`,
      [next.user_id, peonId, sessionId, next.occurrence_key, completedAt],
    );
    const changed = updated.rows[0];
    if (changed && !users.includes(changed.user_id)) users.push(changed.user_id);
    return users;
  });
  // At most two operators are touched by one completion (the one whose request
  // finished and, if they differ, the one whose notification it was).
  for (const userId of touched) await publishAttention(workspaceId, userId, peonId, sessionId, completedAt, completedAt);
}

export async function markSessionAttentionRead(
  workspaceId: string,
  userId: string,
  peonId: string,
  sessionId: string,
): Promise<boolean> {
  const now = Date.now();
  const result = await query(
    `UPDATE session_attention SET state='read', read_at=$5
     WHERE workspace_id=$1 AND user_id=$2 AND peon_id=$3 AND session_id=$4 AND state IN ('pending','unread')`,
    [workspaceId, userId, peonId, sessionId, now],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  // Whatever was queued for this session is now about something the user is
  // looking at. Dropping it is best-effort: a failure here costs a redundant
  // notification, never a lost one.
  await cancelPendingPush(userId, peonId, sessionId).catch((error) => {
    console.warn("push: cancelling queued notifications failed:", error instanceof Error ? error.message : String(error));
  });
  // Reading acknowledges the answer; it does not finish a run, so the published
  // projection can still carry hasOutstandingRequest.
  await publishAttention(workspaceId, userId, peonId, sessionId, null, now);
  return true;
}

export async function sessionAttentionStates(workspaceId: string, userId: string): Promise<Map<string, SessionAttentionProjection>> {
  const { rows } = await query<{ peon_id: string; session_id: string; state: string; requested_at: number | string; completed_at: number | string | null; read_at: number | string | null; resolved_at: number | string | null }>(
    `SELECT peon_id, session_id, state, requested_at, completed_at, read_at, resolved_at FROM session_attention
     WHERE workspace_id=$1 AND user_id=$2`,
    [workspaceId, userId],
  );
  const states = new Map<string, SessionAttentionProjection>();
  for (const row of rows) {
    const key = `${row.peon_id}\0${row.session_id}`;
    const requestedAt = Number(row.requested_at);
    const updatedAt = Math.max(requestedAt, Number(row.completed_at ?? 0), Number(row.read_at ?? 0), Number(row.resolved_at ?? 0));
    const previous = states.get(key);
    states.set(key, {
      unread: (previous?.unread ?? false) || row.state === "unread",
      hasOutstandingRequest: (previous?.hasOutstandingRequest ?? false) || row.resolved_at === null,
      lastRequestedAt: Math.max(previous?.lastRequestedAt ?? 0, requestedAt),
      updatedAt: Math.max(previous?.updatedAt ?? 0, updatedAt),
    });
  }
  return states;
}

export async function deleteSessionAttention(peonId: string, sessionId: string): Promise<void> {
  await query(`DELETE FROM session_attention WHERE peon_id=$1 AND session_id=$2`, [peonId, sessionId]);
}

export async function cancelSessionRequest(peonId: string, sessionId: string, occurrenceKey: string): Promise<void> {
  await query(
    // A dequeued command never ran: only an occurrence that is still outstanding
    // and still unanswered may be withdrawn.
    `DELETE FROM session_attention WHERE peon_id=$1 AND session_id=$2 AND occurrence_key=$3 AND completed_at IS NULL AND resolved_at IS NULL`,
    [peonId, sessionId, occurrenceKey],
  );
}
