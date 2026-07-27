import { randomUUID } from "node:crypto";
import { query, withAdvisoryLock } from "./db.js";
import { membership } from "./workspaces.js";
import { canAccessPeon, canAccessProject } from "./access.js";
import { fcmEnabled, fcmSender, plainText, PushDeliveryError, type PushMessage } from "./infrastructure/push/index.js";
import type { LiveEvent } from "./eventLog.js";
import type { SessionAttentionPayload } from "./sessionAttention.js";

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

// Which providers this instance can actually reach. Expo authenticates the
// token itself, so it is always deliverable; FCM only exists once a service
// account is configured. A subscription for an unreachable provider is neither
// enqueued nor selected for delivery — a queue of messages nothing can send is
// worse than no queue at all.
function deliverableProviders(): PushProvider[] {
  return fcmEnabled() ? ["expo", "fcm"] : ["expo"];
}

// The values are this module's own literals, never request input.
function providerList(): string {
  return deliverableProviders().map((p) => `'${p}'`).join(",");
}

// What the phone actually reads. The attention event itself carries only the
// bookkeeping (who, which session, unread), so the human-readable half is read
// back from the session index at enqueue time — once per finished turn, which
// is a rate a query can afford.
//
// The project leads the title because a notification arrives with no context
// around it: "Billing API — Fix the webhook retry" answers "where?" before
// "what?", and a phone truncating the tail still shows which project woke you.
// Both halves are flattened out of Markdown — see plainText.
function notificationPayload(event: LiveEvent, session: SessionSummary | null) {
  const title = plainText(session?.title ?? "") || "Session finished";
  const project = plainText(session?.projectName ?? "");
  return {
    title: project ? `${project} — ${title}` : title,
    body: plainText(session?.preview ?? "") || "Your run has finished",
    data: { workspaceId: event.workspaceId, peonId: event.peonId, sessionId: event.sessionId, kind: event.kind, cursor: event.cursor },
  };
}

interface SessionSummary { title: string | null; preview: string | null; projectKey: string | null; projectId: string | null; projectName: string | null }

// Two queries rather than one join: the catalog row is keyed by project_id but
// older sessions carry only a project_key, and expressing that fallback as a
// join condition costs more than a second lookup on a path that runs once per
// finished turn.
async function projectName(peonId: string, projectId: string | null, projectKey: string | null): Promise<string | null> {
  if (!projectId && !projectKey) return null;
  const { rows } = projectId
    ? await query<{ name: string | null }>(`SELECT name FROM projects WHERE peon_id=$1 AND project_id=$2`, [peonId, projectId])
    : await query<{ name: string | null }>(`SELECT name FROM projects WHERE peon_id=$1 AND project_key=$2`, [peonId, projectKey]);
  // The dashboard shows `name || key`; a notification should not disagree with
  // the screen the user opens next.
  return rows[0]?.name?.trim() || projectKey;
}

async function sessionSummary(peonId: string, sessionId: string): Promise<SessionSummary | null> {
  const { rows } = await query<{ title: string | null; preview: string | null; project_key: string | null; project_id: string | null }>(
    `SELECT title, preview, project_key, project_id FROM sessions WHERE peon_id=$1 AND session_id=$2`, [peonId, sessionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    title: row.title,
    preview: row.preview,
    projectKey: row.project_key,
    projectId: row.project_id,
    projectName: await projectName(peonId, row.project_id, row.project_key),
  };
}

// A notification is for one person: whoever asked for the turn that just
// finished, and only if they were not watching it finish. That is exactly the
// `session_attention` transition to unread, so push hangs off it rather than
// off the session firehose — a running session emits an event per activity
// tick, and none of those are worth a buzz.
//
// Hanging off attention also inherits its presence rule for free:
// completeNextSessionAttention retires the occurrence as *read* when the
// requester is sitting in front of that very session on any connected device,
// so no unread transition happens and nothing is enqueued.
export async function enqueuePushForEvent(event: LiveEvent): Promise<void> {
  if (event.cursor <= 0 || event.kind !== "attention" || !event.sessionId) return;
  const attention = event.payload && typeof event.payload === "object" ? event.payload as Partial<SessionAttentionPayload> : null;
  // unread=false is the read receipt — the same event kind, carrying the
  // opposite meaning. `completedAt` is what makes this a *completion*: attention
  // events also announce accepted requests and read receipts, and those carry
  // the session's standing unread flag without a new turn having finished.
  if (attention?.unread !== true || typeof attention.completedAt !== "number" || typeof attention.userId !== "string") return;
  const userId = attention.userId;

  // The requester had access when they started the run; re-check it here
  // because a notification can outlive the grant that allowed the request.
  const role = await membership(event.workspaceId, userId);
  if (!role || !(await canAccessPeon(event.workspaceId, userId, role, event.peonId))) return;
  const session = await sessionSummary(event.peonId, event.sessionId);
  if (session?.projectKey && !(await canAccessProject(event.workspaceId, userId, role, event.peonId, session.projectKey, session.projectId))) return;

  const payload = JSON.stringify(notificationPayload(event, session));
  const { rows } = await query<{ id: string }>(
    `SELECT s.id FROM push_subscriptions s
       LEFT JOIN push_preferences p ON p.user_id=s.user_id AND p.workspace_id=$2
      WHERE s.user_id=$1 AND s.disabled_at IS NULL AND s.provider IN (${providerList()})
        AND COALESCE(p.enabled, TRUE)=TRUE AND COALESCE(p.session_events, TRUE)=TRUE`,
    [userId, event.workspaceId],
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

// Read on one device, silent on the others. The worker drains every five
// seconds and backs off after a failure, so there is a real window in which a
// queued notification is about a session the user has already opened
// elsewhere. Delivering it then is noise, and unlike a presence check this
// reads committed state rather than a socket's liveness.
export async function cancelPendingPush(userId: string, peonId: string, sessionId: string): Promise<void> {
  await query(
    `DELETE FROM push_outbox WHERE delivered_at IS NULL
       AND subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=$1)
       AND event_cursor IN (SELECT cursor FROM events WHERE peon_id=$2 AND session_id=$3)`,
    [userId, peonId, sessionId],
  );
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
  await withAdvisoryLock("overseer:push-delivery", deliverPendingLocked);
}

async function sendViaExpo(token: string, message: PushMessage): Promise<void> {
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ to: token, sound: "default", ...message }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as { data?: { status?: string; message?: string; details?: { error?: string } } };
  if (response.ok && result.data?.status !== "error") return;
  const reason = result.data?.message ?? `Expo HTTP ${response.status}`;
  // Expo reports a retired install the same way FCM does, just under its own
  // name; treating it as permanent is what keeps a reinstalled phone from
  // collecting a queue that can never drain.
  throw new PushDeliveryError(reason, result.data?.details?.error === "DeviceNotRegistered");
}

async function sendViaFcm(token: string, message: PushMessage): Promise<void> {
  const sender = fcmSender();
  if (!sender) throw new PushDeliveryError("FCM is not configured", false);
  await sender.send(token, message);
}

async function deliverPendingLocked(): Promise<void> {
  const { rows } = await query<{ id: string; subscription_id: string; provider: PushProvider; token: string; payload: unknown; attempts: number }>(
    `SELECT o.id,o.subscription_id,s.provider,s.token,o.payload,o.attempts FROM push_outbox o JOIN push_subscriptions s ON s.id=o.subscription_id
      WHERE o.delivered_at IS NULL AND o.available_at <= $1 AND s.disabled_at IS NULL AND s.provider IN (${providerList()})
      ORDER BY o.created_at LIMIT 100`, [Date.now()],
  );
  for (const row of rows) {
    const message = (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as PushMessage;
    try {
      if (row.provider === "fcm") await sendViaFcm(row.token, message);
      else await sendViaExpo(row.token, message);
      await query(`UPDATE push_outbox SET delivered_at=$2,last_error=NULL WHERE id=$1`, [row.id, Date.now()]);
    } catch (err) {
      const attempts = row.attempts + 1;
      const error = String(err).slice(0, 500);
      // A permanent failure is about the device, not the message: retire the
      // subscription so its queued messages drop out of the delivery join
      // instead of being retried for an hour at a time, forever.
      if (err instanceof PushDeliveryError && err.permanent) {
        await query(`UPDATE push_subscriptions SET disabled_at=$2 WHERE id=$1`, [row.subscription_id, Date.now()]);
        await query(`UPDATE push_outbox SET attempts=$2,last_error=$3 WHERE id=$1`, [row.id, attempts, error]);
        continue;
      }
      const delay = Math.min(60 * 60_000, 5_000 * 2 ** Math.min(attempts, 10));
      await query(`UPDATE push_outbox SET attempts=$2,available_at=$3,last_error=$4 WHERE id=$1`, [row.id, attempts, Date.now() + delay, error]);
    }
  }
}
