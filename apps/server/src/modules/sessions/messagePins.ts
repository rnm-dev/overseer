import { query, transactionWithAdvisoryLock } from "../../infrastructure/db/index.js";

export function validPinEventId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(id);
}
export async function listMessagePins(workspace: string, peon: string, session: string) {
  const { rows } = await query(`SELECT event_id AS "eventId", event, pinned_by AS "pinnedBy", created_at AS "createdAt"
    FROM session_message_pins WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3 ORDER BY created_at DESC, event_id ASC`, [workspace, peon, session]);
  return rows;
}
export async function pinMessage(workspace: string, peon: string, session: string, eventId: string, event: unknown, actor: string) {
  if (!validPinEventId(eventId) || Buffer.byteLength(JSON.stringify(event)) > 131072) throw new Error("Invalid or oversized pinned message");
  return transactionWithAdvisoryLock(`message-pins:${workspace}:${peon}:${session}`, async (tx) => {
    const existing = await tx.query(`SELECT event_id FROM session_message_pins WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3`, [workspace, peon, session]);
    if (existing.rows.some((row) => row.event_id === eventId)) return true;
    if (existing.rows.length >= 50) return false;
    await tx.query(`INSERT INTO session_message_pins (workspace_id,peon_id,session_id,event_id,event,pinned_by,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [workspace, peon, session, eventId, JSON.stringify(event), actor, Date.now()]);
    return true;
  });
}
export async function unpinMessage(workspace: string, peon: string, session: string, eventId: string) {
  await query(`DELETE FROM session_message_pins WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3 AND event_id=$4`, [workspace, peon, session, eventId]);
}

export async function deleteSessionPins(workspace: string, peon: string, session: string) {
  await query(`DELETE FROM session_message_pins WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3`, [workspace, peon, session]);
}
