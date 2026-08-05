import { query } from "../db/index.js";
import { PushDeliveryError } from "./fcm.js";
import { fcmSender } from "./pushSender.js";
import { liveActivityPayload, liveActivityTopic } from "./liveActivity.js";

interface ActiveClaimRow {
  connection_id: string;
  completed_count: number;
}

interface UpdateTokenRow {
  token: string;
  bundle_id: string | null;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/** Retire all ActivityKit state owned by a revoked device. */
export async function disableLiveActivitiesForDevice(userId: string, deviceId: string): Promise<void> {
  const now = Date.now();
  const { rows } = await query<ActiveClaimRow>(
    `SELECT connection_id, completed_count FROM live_activity_claims
      WHERE user_id=$1 AND device_id=$2 AND state <> 'idle'`,
    [userId, deviceId],
  );
  for (const row of rows) {
    const { rows: tokens } = await query<UpdateTokenRow>(
      `SELECT token, bundle_id FROM live_activity_tokens
        WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND kind='update' AND disabled_at IS NULL`,
      [userId, deviceId, row.connection_id],
    );
    const { rows: registrations } = await query<{ token: string }>(
      `SELECT token FROM push_subscriptions
        WHERE user_id=$1 AND device_id=$2 AND provider='fcm' AND disabled_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [userId, deviceId],
    );
    const token = tokens[0];
    const registrationToken = registrations[0]?.token;
    if (token && registrationToken) {
      await (async () => {
        const sender = fcmSender();
        if (!sender) throw new PushDeliveryError("FCM is not configured", false);
        await sender.sendLiveActivity({
          registrationToken,
          activityToken: token.token,
          payload: liveActivityPayload({
            event: "end",
            now,
            state: { runningCount: 0, completedCount: row.completed_count, oldestStartedAt: null, updatedAt: now },
          }),
          topic: liveActivityTopic(token.bundle_id),
        });
      })().catch((error) => console.warn("live activity: ending on device revocation failed:", describe(error)));
    }
    await query(
      `UPDATE live_activity_claims
          SET state='idle', activity_id=NULL, running_count=0, completed_count=0,
              oldest_started_at=NULL, ended_at=$4, updated_at=$4, last_error=NULL
        WHERE user_id=$1 AND device_id=$2 AND connection_id=$3`,
      [userId, deviceId, row.connection_id, now],
    );
    await query(
      `DELETE FROM live_activity_tokens WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND kind='update'`,
      [userId, deviceId, row.connection_id],
    );
  }
  await query(
    `UPDATE live_activity_tokens SET disabled_at=$3 WHERE user_id=$1 AND device_id=$2 AND disabled_at IS NULL`,
    [userId, deviceId, now],
  );
}
