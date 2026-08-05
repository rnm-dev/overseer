import { query } from "../db/index.js";

// Read on one device, silent on the others. The worker drains every five
// seconds and backs off after a failure, so there is a real window in which a
// queued notification is about a session the user has already opened elsewhere.
export async function cancelPendingPush(userId: string, peonId: string, sessionId: string): Promise<void> {
  await query(
    `DELETE FROM push_outbox WHERE delivered_at IS NULL
       AND subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=$1)
       AND event_cursor IN (SELECT cursor FROM events WHERE peon_id=$2 AND session_id=$3)`,
    [userId, peonId, sessionId],
  );
}
