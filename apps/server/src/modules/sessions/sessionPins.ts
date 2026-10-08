import { query, transactionWithAdvisoryLock } from "../../infrastructure/db/index.js";
export async function listSessionPins(workspace: string, user: string) {
  const result = await query<{ peon_id: string; session_id: string }>(`SELECT peon_id,session_id FROM session_pins WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC`, [workspace, user]);
  return result.rows;
}
export async function setSessionPinned(workspace: string, user: string, peon: string, session: string, pinned: boolean) {
  return transactionWithAdvisoryLock(`session-pins:${workspace}:${user}`, async (tx) => {
    if (!pinned) {
      await tx.query(`DELETE FROM session_pins WHERE workspace_id=$1 AND user_id=$2 AND peon_id=$3 AND session_id=$4`, [workspace, user, peon, session]);
      return true;
    }
    const rows = await tx.query<{ peon_id: string; session_id: string }>(`SELECT peon_id,session_id FROM session_pins WHERE workspace_id=$1 AND user_id=$2`, [workspace, user]);
    if (rows.rows.some((row) => row.peon_id === peon && row.session_id === session)) return true;
    if (rows.rows.length >= 50) return false;
    await tx.query(`INSERT INTO session_pins (workspace_id,user_id,peon_id,session_id,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [workspace,user,peon,session,Date.now()]);
    return true;
  });
}
export async function deleteSessionPins(workspace: string, peon: string, session: string) {
  await query(`DELETE FROM session_pins WHERE workspace_id=$1 AND peon_id=$2 AND session_id=$3`, [workspace, peon, session]);
}
