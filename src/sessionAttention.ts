import { appendEvent } from "./eventLog.js";
import { query, transaction } from "./db.js";
import { isUserViewingSession } from "./modules/presence/index.js";
import { cancelPendingPush } from "./push.js";

export interface SessionAttentionPayload {
  userId: string;
  peonId: string;
  sessionId: string;
  unread: boolean;
  completedAt: number | null;
  updatedAt: number;
}

export async function recordSessionRequest(input: {
  workspaceId: string;
  userId: string;
  peonId: string;
  sessionId: string;
  occurrenceKey: string;
  requestedAt?: number;
}): Promise<void> {
  await query(
    `INSERT INTO session_attention
       (workspace_id, user_id, peon_id, session_id, occurrence_key, state, requested_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6)
     ON CONFLICT (user_id, peon_id, session_id, occurrence_key) DO NOTHING`,
    [input.workspaceId, input.userId, input.peonId, input.sessionId, input.occurrenceKey, input.requestedAt ?? Date.now()],
  );
}

export async function completeNextSessionAttention(
  workspaceId: string,
  peonId: string,
  sessionId: string,
  completedAt: number,
): Promise<void> {
  const row = await transaction(async (tx) => {
    // Only a still-pending occurrence can become unread. An occurrence the user
    // already viewed is terminal, and it must not sit at the head of the queue
    // soaking up the completions that belong to later requests.
    const pending = await tx.query<{ user_id: string; occurrence_key: string }>(
      `SELECT user_id, occurrence_key FROM session_attention
       WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3 AND state='pending' AND completed_at IS NULL
       ORDER BY requested_at ASC LIMIT 1`,
      [workspaceId, peonId, sessionId],
    );
    const next = pending.rows[0];
    if (!next) return null;
    // Attention means "this finished while you were not looking". If the requester
    // is in front of this very session, the occurrence is already seen: retire it
    // as read so no unread edge appears on the session they are sitting in.
    const seen = isUserViewingSession(workspaceId, next.user_id, peonId, sessionId);
    const updated = await tx.query<{ user_id: string; state: string }>(
      seen
        ? `UPDATE session_attention SET state='read', completed_at = $5, read_at = $5
       WHERE user_id=$1 AND peon_id=$2 AND session_id=$3 AND occurrence_key=$4
         AND state='pending' AND completed_at IS NULL
       RETURNING user_id, state`
        : `UPDATE session_attention SET state='unread', completed_at = $5
       WHERE user_id=$1 AND peon_id=$2 AND session_id=$3 AND occurrence_key=$4
         AND state='pending' AND completed_at IS NULL
       RETURNING user_id, state`,
      [next.user_id, peonId, sessionId, next.occurrence_key, completedAt],
    );
    return updated.rows[0] ?? null;
  });
  if (!row) return;
  await appendEvent({
    workspaceId,
    peonId,
    sessionId,
    kind: "attention",
    payload: { userId: row.user_id, peonId, sessionId, unread: row.state === "unread", completedAt, updatedAt: completedAt } satisfies SessionAttentionPayload,
  });
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
  await appendEvent({
    workspaceId,
    peonId,
    sessionId,
    kind: "attention",
    payload: { userId, peonId, sessionId, unread: false, completedAt: null, updatedAt: now } satisfies SessionAttentionPayload,
  });
  return true;
}

export async function sessionAttentionStates(workspaceId: string, userId: string): Promise<Map<string, { unread: boolean; updatedAt: number }>> {
  const { rows } = await query<{ peon_id: string; session_id: string; state: string; requested_at: number; completed_at: number | null; read_at: number | null }>(
    `SELECT peon_id, session_id, state, requested_at, completed_at, read_at FROM session_attention
     WHERE workspace_id=$1 AND user_id=$2`,
    [workspaceId, userId],
  );
  const states = new Map<string, { unread: boolean; updatedAt: number }>();
  for (const row of rows) {
    const key = `${row.peon_id}\0${row.session_id}`;
    const updatedAt = Math.max(row.requested_at, row.completed_at ?? 0, row.read_at ?? 0);
    const previous = states.get(key);
    states.set(key, {
      unread: (previous?.unread ?? false) || row.state === "unread",
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
    `DELETE FROM session_attention WHERE peon_id=$1 AND session_id=$2 AND occurrence_key=$3 AND completed_at IS NULL`,
    [peonId, sessionId, occurrenceKey],
  );
}
