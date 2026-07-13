import { randomUUID } from "node:crypto";
import { query } from "./db.js";
import type { EventKind, LiveEvent } from "./eventLog.js";

export type PushProvider = "expo" | "fcm" | "apns";
export type PushPlatform = "ios" | "android";

export interface PushSubscriptionView {
  id: string;
  provider: PushProvider;
  platform: PushPlatform;
  appId: string | null;
  createdAt: number;
  updatedAt: number;
}

export async function upsertPushSubscription(input: {
  userId: string; deviceId: string; provider: PushProvider; platform: PushPlatform; token: string; appId: string | null;
}): Promise<PushSubscriptionView> {
  const now = Date.now();
  const existing = await query<{ id: string; created_at: number }>(
    `SELECT id, created_at FROM push_subscriptions WHERE provider=$1 AND token=$2`, [input.provider, input.token],
  );
  const id = existing.rows[0]?.id ?? randomUUID();
  const createdAt = existing.rows[0]?.created_at ?? now;
  if (existing.rows[0]) {
    await query(
      `UPDATE push_subscriptions SET user_id=$2, device_id=$3, platform=$4, app_id=$5, updated_at=$6, disabled_at=NULL WHERE id=$1`,
      [id, input.userId, input.deviceId, input.platform, input.appId, now],
    );
  } else {
    await query(
      `INSERT INTO push_subscriptions (id,user_id,device_id,provider,platform,token,app_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [id, input.userId, input.deviceId, input.provider, input.platform, input.token, input.appId, now],
    );
  }
  return { id, provider: input.provider, platform: input.platform, appId: input.appId, createdAt, updatedAt: now };
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionView[]> {
  const { rows } = await query<{ id: string; provider: PushProvider; platform: PushPlatform; app_id: string | null; created_at: number; updated_at: number }>(
    `SELECT id,provider,platform,app_id,created_at,updated_at FROM push_subscriptions WHERE user_id=$1 AND disabled_at IS NULL ORDER BY created_at`, [userId],
  );
  return rows.map((r) => ({ id: r.id, provider: r.provider, platform: r.platform, appId: r.app_id, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export async function removePushSubscription(userId: string, id: string): Promise<boolean> {
  const result = await query(`DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2`, [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function getPushPreferences(userId: string, workspaceId: string) {
  const { rows } = await query<{ enabled: boolean; session_events: boolean; peon_events: boolean }>(
    `SELECT enabled,session_events,peon_events FROM push_preferences WHERE user_id=$1 AND workspace_id=$2`, [userId, workspaceId],
  );
  return rows[0] ?? { enabled: true, session_events: true, peon_events: true };
}

export async function setPushPreferences(userId: string, workspaceId: string, value: { enabled: boolean; sessionEvents: boolean; peonEvents: boolean }) {
  await query(
    `INSERT INTO push_preferences (user_id,workspace_id,enabled,session_events,peon_events,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id,workspace_id) DO UPDATE SET enabled=$3,session_events=$4,peon_events=$5,updated_at=$6`,
    [userId, workspaceId, value.enabled, value.sessionEvents, value.peonEvents, Date.now()],
  );
  return value;
}

function notificationPayload(event: LiveEvent) {
  const data = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const title = event.kind === "session" ? String(data.title ?? "Session updated") : String(data.name ?? "Peon updated");
  return {
    title,
    body: event.kind === "session" ? String(data.preview ?? data.status ?? "Open Overseer for details") : String(data.status ?? "Agent status changed"),
    data: { workspaceId: event.workspaceId, peonId: event.peonId, sessionId: event.sessionId, kind: event.kind, cursor: event.cursor },
  };
}

export async function enqueuePushForEvent(event: LiveEvent): Promise<void> {
  if (event.cursor <= 0) return;
  const payload = JSON.stringify(notificationPayload(event));
  const enabledColumn: Record<EventKind, string> = { session: "session_events", peon: "peon_events" };
  const { rows } = await query<{ id: string }>(
    `SELECT s.id FROM push_subscriptions s
       JOIN workspace_members m ON m.user_id=s.user_id AND m.workspace_id=$1
       LEFT JOIN push_preferences p ON p.user_id=s.user_id AND p.workspace_id=$1
      WHERE s.disabled_at IS NULL AND s.provider='expo'
        AND COALESCE(p.enabled, TRUE)=TRUE AND COALESCE(p.${enabledColumn[event.kind]}, TRUE)=TRUE`,
    [event.workspaceId],
  );
  const now = Date.now();
  for (const row of rows) {
    await query(
      `INSERT INTO push_outbox (id,event_cursor,subscription_id,payload,available_at,created_at) VALUES ($1,$2,$3,$4,$5,$5)
       ON CONFLICT (event_cursor,subscription_id) DO NOTHING`,
      [randomUUID(), event.cursor, row.id, payload, now],
    );
  }
}

let worker: ReturnType<typeof setInterval> | null = null;
let deliveryRunning = false;
export function startPushWorker(): void {
  if (worker) return;
  const run = () => {
    if (deliveryRunning) return;
    deliveryRunning = true;
    void deliverPending()
      .catch((err) => console.error("push: delivery pass failed:", err instanceof Error ? err.message : err))
      .finally(() => { deliveryRunning = false; });
  };
  run();
  worker = setInterval(run, 5_000);
}

export async function deliverPending(): Promise<void> {
  const { rows } = await query<{ id: string; token: string; payload: unknown; attempts: number }>(
    `SELECT o.id,s.token,o.payload,o.attempts FROM push_outbox o JOIN push_subscriptions s ON s.id=o.subscription_id
      WHERE o.delivered_at IS NULL AND o.available_at <= $1 AND s.disabled_at IS NULL AND s.provider='expo'
      ORDER BY o.created_at LIMIT 100`, [Date.now()],
  );
  for (const row of rows) {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload as Record<string, unknown>;
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ to: row.token, sound: "default", ...payload }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as { data?: { status?: string; message?: string } };
      if (!response.ok || result.data?.status === "error") throw new Error(result.data?.message ?? `Expo HTTP ${response.status}`);
      await query(`UPDATE push_outbox SET delivered_at=$2,last_error=NULL WHERE id=$1`, [row.id, Date.now()]);
    } catch (err) {
      const attempts = row.attempts + 1;
      const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts, 10));
      await query(`UPDATE push_outbox SET attempts=$2,available_at=$3,last_error=$4 WHERE id=$1`, [row.id, attempts, Date.now() + delay, String(err).slice(0, 500)]);
    }
  }
}
