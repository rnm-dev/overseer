import { randomUUID } from "node:crypto";
import { query } from "./db.js";
import { membership, type Role } from "./workspaces.js";
import { canAccessPeon, canAccessProject } from "./access.js";
import {
  fcmEnabled,
  fcmSender,
  liveActivityPayload,
  liveActivityTopic,
  PushDeliveryError,
  startAlert,
  type LiveActivityContentState,
} from "./infrastructure/push/index.js";
import type { LiveEvent } from "./eventLog.js";

// One Live Activity per operator per device connection — an aggregate of
// everything that operator has running, never one activity per session. That
// single sentence is the whole design constraint, and three mechanisms enforce
// it:
//
//   * the **claim** row is keyed by (user, device, connection), so a conditional
//     UPDATE off `state='idle'` is the atomic right-to-start. Two events landing
//     together produce one winner and one no-op, in this process or another.
//   * the aggregate is **recomputed from committed state**, never incremented.
//     Concurrent session events converge because each one asks the database the
//     same question and gets the same answer.
//   * ownership comes from `session_attention.user_id` — recorded server-side
//     from the authenticated caller when a turn was accepted — not from the
//     `author` a session carries, which is an actor string that arrived over the
//     wire.
//
// Push notifications and Live Activities are deliberately independent: an FCM
// registration token addresses the app's notification channel, an ActivityKit
// token addresses one activity. They rotate on different schedules and are
// stored apart.

export type LiveActivityTokenKind = "start" | "update";
export type LiveActivityState = "idle" | "starting" | "active";

export interface LiveActivityScope {
  userId: string;
  deviceId: string;
  connectionId: string;
}

export interface LiveActivityScopeView {
  connectionId: string;
  state: LiveActivityState;
  activityId: string | null;
  hasStartToken: boolean;
  hasUpdateToken: boolean;
  runningCount: number;
  completedCount: number;
  updatedAt: number;
}

interface TokenRow {
  id: string;
  token: string;
  bundle_id: string | null;
  activity_id: string | null;
}

interface ClaimRow {
  state: LiveActivityState;
  activity_id: string | null;
  running_count: number;
  completed_count: number;
  oldest_started_at: number | null;
  content_updated_at: number;
}

// The attribute identity the iOS client declares: stable per connection, so a
// restarted activity is recognisably the same aggregate.
export function aggregateActivityId(connectionId: string): string {
  return `overseer:${connectionId}`;
}

// ---------------------------------------------------------------------------
// Token registration
// ---------------------------------------------------------------------------

async function upsertToken(
  scope: LiveActivityScope,
  kind: LiveActivityTokenKind,
  token: string,
  bundleId: string | null,
  activityId: string | null,
): Promise<void> {
  const now = Date.now();
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM live_activity_tokens WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND kind=$4`,
    [scope.userId, scope.deviceId, scope.connectionId, kind],
  );
  if (rows[0]) {
    // Rotation is an overwrite, not a second row: ActivityKit reissues both
    // token kinds on its own schedule and the old value is dead the moment it
    // does.
    await query(
      `UPDATE live_activity_tokens SET token=$2, bundle_id=$3, activity_id=$4, updated_at=$5, disabled_at=NULL WHERE id=$1`,
      [rows[0].id, token, bundleId, activityId, now],
    );
    return;
  }
  await query(
    `INSERT INTO live_activity_tokens (id,user_id,device_id,connection_id,kind,activity_id,token,bundle_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [randomUUID(), scope.userId, scope.deviceId, scope.connectionId, kind, activityId, token, bundleId, now],
  );
}

async function tokenFor(scope: LiveActivityScope, kind: LiveActivityTokenKind): Promise<TokenRow | null> {
  const { rows } = await query<TokenRow>(
    `SELECT id, token, bundle_id, activity_id FROM live_activity_tokens
      WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND kind=$4 AND disabled_at IS NULL`,
    [scope.userId, scope.deviceId, scope.connectionId, kind],
  );
  return rows[0] ?? null;
}

async function disableToken(id: string): Promise<void> {
  await query(`UPDATE live_activity_tokens SET disabled_at=$2 WHERE id=$1`, [id, Date.now()]);
}

/** iOS 17.2+ device-scoped push-to-start token. Registering it enables remote start. */
export async function registerLiveActivityStartToken(
  input: LiveActivityScope & { token: string; bundleId?: string | null },
): Promise<void> {
  await upsertToken(input, "start", input.token, input.bundleId ?? null, null);
  await syncLiveActivitiesForUser(input.userId);
}

/**
 * The per-activity update token the app emits once ActivityKit has created the
 * aggregate. It binds to the existing claim rather than creating a second one —
 * this is the far side of a remote start.
 */
export async function bindLiveActivityUpdateToken(
  input: LiveActivityScope & { activityId: string; token: string; bundleId?: string | null },
): Promise<void> {
  await upsertToken(input, "update", input.token, input.bundleId ?? null, input.activityId);
  const now = Date.now();
  await ensureClaimRow(input, now);
  // An activity the phone created locally (foreground launch, no remote start)
  // is adopted the same way: the server can only update or end what it knows
  // exists, and refusing to adopt would strand it.
  await query(
    `UPDATE live_activity_claims SET state='active', activity_id=$4, updated_at=$5, last_error=NULL
      WHERE user_id=$1 AND device_id=$2 AND connection_id=$3`,
    [input.userId, input.deviceId, input.connectionId, input.activityId, now],
  );
  await syncLiveActivitiesForUser(input.userId);
}

/** The client reporting that an activity is gone, or dropping its start capability. */
export async function removeLiveActivityToken(scope: LiveActivityScope, kind: LiveActivityTokenKind): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM live_activity_tokens WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND kind=$4`,
    [scope.userId, scope.deviceId, scope.connectionId, kind],
  );
  if (kind === "update") await releaseClaim(scope, null, Date.now());
  return (rowCount ?? 0) > 0;
}

/**
 * Sign-out and device revocation. The activity is ended first where that is
 * still possible — a revoked device that keeps showing live session counts is
 * exactly what revocation is supposed to stop — and both token kinds are
 * disabled either way.
 */
export async function disableLiveActivitiesForDevice(userId: string, deviceId: string): Promise<void> {
  const now = Date.now();
  const { rows } = await query<{ connection_id: string; state: LiveActivityState }>(
    `SELECT connection_id, state FROM live_activity_claims WHERE user_id=$1 AND device_id=$2 AND state <> 'idle'`,
    [userId, deviceId],
  );
  for (const row of rows) {
    const scope = { userId, deviceId, connectionId: row.connection_id };
    const token = await tokenFor(scope, "update");
    if (token) {
      const claim = await loadClaim(scope);
      await sendLiveActivity(token, liveActivityPayload({
        event: "end",
        now,
        state: { runningCount: 0, completedCount: claim?.completed_count ?? 0, oldestStartedAt: null, updatedAt: now },
      })).catch((error) => console.warn("live activity: ending on device revocation failed:", describe(error)));
    }
    await releaseClaim(scope, 0, now);
  }
  await query(
    `UPDATE live_activity_tokens SET disabled_at=$3 WHERE user_id=$1 AND device_id=$2 AND disabled_at IS NULL`,
    [userId, deviceId, now],
  );
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

interface OwnedRow {
  workspace_id: string;
  peon_id: string;
  session_id: string;
  state: string;
  requested_at: number;
  status: string | null;
  started_at: number | null;
  last_activity_at: number | null;
  project_key: string | null;
  project_id: string | null;
}

// Access is re-checked here for the same reason push re-checks it at enqueue
// time: an activity outlives the grant that allowed the run, and a count is
// still a disclosure.
async function accessible(row: OwnedRow, userId: string, roles: Map<string, Role | null>, peons: Map<string, boolean>): Promise<boolean> {
  if (!roles.has(row.workspace_id)) roles.set(row.workspace_id, await membership(row.workspace_id, userId));
  const role = roles.get(row.workspace_id) ?? null;
  if (!role) return false;
  const peonKey = `${row.workspace_id}\0${row.peon_id}`;
  if (!peons.has(peonKey)) peons.set(peonKey, await canAccessPeon(row.workspace_id, userId, role, row.peon_id));
  if (!peons.get(peonKey)) return false;
  if (!row.project_key) return true;
  return canAccessProject(row.workspace_id, userId, role, row.peon_id, row.project_key, row.project_id);
}

/**
 * The authoritative aggregate for one operator, recomputed from committed state:
 * running sessions they started that are still running, plus completions they
 * have not read yet. Never derived from a delta.
 */
export async function liveActivityAggregate(userId: string, now = Date.now()): Promise<LiveActivityContentState> {
  const { rows } = await query<OwnedRow>(
    `SELECT a.workspace_id, a.peon_id, a.session_id, a.state, a.requested_at,
            s.status, s.started_at, s.last_activity_at, s.project_key, s.project_id
       FROM session_attention a
       LEFT JOIN sessions s ON s.peon_id = a.peon_id AND s.session_id = a.session_id
      WHERE a.user_id = $1 AND a.state IN ('pending','unread')`,
    [userId],
  );

  const roles = new Map<string, Role | null>();
  const peons = new Map<string, boolean>();
  // Occurrences are per turn; the activity counts sessions. A session with two
  // pending follow-ups is one running session.
  const sessions = new Map<string, { running: boolean; completed: boolean; startedAt: number; activityAt: number }>();
  for (const row of rows) {
    // `pending` means a turn was accepted and has not completed; it only counts
    // as running while the session projection agrees it is running, which is
    // what keeps a Peon that died mid-run from pinning the counter forever.
    const running = row.state === "pending" && row.status === "running";
    const completed = row.state === "unread";
    if (!running && !completed) continue;
    if (!(await accessible(row, userId, roles, peons))) continue;
    const key = `${row.peon_id}\0${row.session_id}`;
    const previous = sessions.get(key);
    sessions.set(key, {
      running: (previous?.running ?? false) || running,
      completed: (previous?.completed ?? false) || completed,
      startedAt: Math.min(previous?.startedAt ?? Number.MAX_SAFE_INTEGER, row.started_at ?? row.requested_at),
      activityAt: Math.max(previous?.activityAt ?? 0, row.last_activity_at ?? row.started_at ?? row.requested_at),
    });
  }

  let runningCount = 0;
  let completedCount = 0;
  let oldestStartedAt: number | null = null;
  let updatedAt = 0;
  for (const session of sessions.values()) {
    if (session.running) {
      runningCount += 1;
      oldestStartedAt = oldestStartedAt === null ? session.startedAt : Math.min(oldestStartedAt, session.startedAt);
    }
    if (session.completed) completedCount += 1;
    updatedAt = Math.max(updatedAt, session.activityAt);
  }
  return { runningCount, completedCount, oldestStartedAt, updatedAt: updatedAt || now };
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

async function loadClaim(scope: LiveActivityScope): Promise<ClaimRow | null> {
  const { rows } = await query<ClaimRow>(
    `SELECT state, activity_id, running_count, completed_count, oldest_started_at, content_updated_at
       FROM live_activity_claims WHERE user_id=$1 AND device_id=$2 AND connection_id=$3`,
    [scope.userId, scope.deviceId, scope.connectionId],
  );
  return rows[0] ?? null;
}

async function ensureClaimRow(scope: LiveActivityScope, now: number): Promise<void> {
  await query(
    `INSERT INTO live_activity_claims (user_id,device_id,connection_id,state,running_count,completed_count,content_updated_at,updated_at)
     VALUES ($1,$2,$3,'idle',0,0,0,$4)
     ON CONFLICT (user_id,device_id,connection_id) DO NOTHING`,
    [scope.userId, scope.deviceId, scope.connectionId, now],
  );
}

// The one-aggregate invariant, in one statement. Whoever flips the row out of
// `idle` owns the start; everyone else sees zero rows back and takes the update
// path. Postgres re-evaluates the predicate after the row lock, so a second
// caller cannot win with a stale read, and the row survives a process restart —
// a retry after a crash finds the claim already taken.
async function claimStart(scope: LiveActivityScope, state: LiveActivityContentState, now: number): Promise<boolean> {
  await ensureClaimRow(scope, now);
  const { rowCount } = await query(
    `UPDATE live_activity_claims
        SET state='starting', activity_id=$4, running_count=$5, completed_count=$6, oldest_started_at=$7,
            content_updated_at=$8, started_at=$9, ended_at=NULL, updated_at=$9, last_error=NULL
      WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND state='idle'`,
    [
      scope.userId, scope.deviceId, scope.connectionId, aggregateActivityId(scope.connectionId),
      state.runningCount, state.completedCount, state.oldestStartedAt, state.updatedAt, now,
    ],
  );
  return (rowCount ?? 0) > 0;
}

async function recordSent(scope: LiveActivityScope, state: LiveActivityContentState, now: number): Promise<void> {
  await query(
    `UPDATE live_activity_claims SET running_count=$4, completed_count=$5, oldest_started_at=$6,
            content_updated_at=$7, updated_at=$8, last_error=NULL
      WHERE user_id=$1 AND device_id=$2 AND connection_id=$3`,
    [scope.userId, scope.deviceId, scope.connectionId, state.runningCount, state.completedCount, state.oldestStartedAt, state.updatedAt, now],
  );
}

// Back to idle, keeping the final completedCount the end push carried. The
// update token dies with the activity it addressed; leaving it behind would
// point the next start's follow-up at an activity that no longer exists.
async function releaseClaim(scope: LiveActivityScope, completedCount: number | null, now: number, error?: string): Promise<void> {
  await query(
    `UPDATE live_activity_claims
        SET state='idle', activity_id=NULL, running_count=0, completed_count=COALESCE($4, completed_count),
            oldest_started_at=NULL, ended_at=$5, updated_at=$5, last_error=$6
      WHERE user_id=$1 AND device_id=$2 AND connection_id=$3`,
    [scope.userId, scope.deviceId, scope.connectionId, completedCount, now, error ?? null],
  );
  await query(
    `DELETE FROM live_activity_tokens WHERE user_id=$1 AND device_id=$2 AND connection_id=$3 AND kind='update'`,
    [scope.userId, scope.deviceId, scope.connectionId],
  );
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

// Never interpolate a token into an error: these strings reach logs and the
// claim row. The sender's messages are FCM's own and carry no token.
function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function sendLiveActivity(token: TokenRow, payload: Record<string, unknown>): Promise<void> {
  const sender = fcmSender();
  if (!sender) throw new PushDeliveryError("FCM is not configured", false);
  await sender.sendLiveActivity({ token: token.token, payload, topic: liveActivityTopic(token.bundle_id) });
}

// Only the counts decide whether a push is worth sending. `updatedAt` moves on
// every activity tick of a running session, and an update per tick would be a
// metronome — the same reason ordinary notifications hang off attention rather
// than off the session firehose. It rides along with the next real change.
function materiallyEqual(claim: ClaimRow, state: LiveActivityContentState): boolean {
  return claim.running_count === state.runningCount
    && claim.completed_count === state.completedCount
    && (claim.oldest_started_at ?? null) === state.oldestStartedAt;
}

async function applyToScope(scope: LiveActivityScope, state: LiveActivityContentState, now: number): Promise<void> {
  const claim = await loadClaim(scope);
  const active = claim !== null && claim.state !== "idle";

  if (!active) {
    if (state.runningCount <= 0) return;
    const startToken = await tokenFor(scope, "start");
    // iOS below 17.2 has no push-to-start token. It reconciles the aggregate
    // when the app launches; emulating a start with an ordinary notification
    // would be a buzz the operator did not ask for.
    if (!startToken) return;
    if (!(await claimStart(scope, state, now))) return;
    try {
      await sendLiveActivity(startToken, liveActivityPayload({
        event: "start",
        now,
        state,
        attributes: { activityId: aggregateActivityId(scope.connectionId), connectionId: scope.connectionId },
        // Apple requires a visible alert on a push-to-start.
        alert: startAlert(state.runningCount),
      }));
    } catch (error) {
      // The claim is released either way: holding it after a failed start would
      // block every later attempt behind an activity that was never created.
      await releaseClaim(scope, null, now, describe(error));
      if (error instanceof PushDeliveryError && error.permanent) await disableToken(startToken.id);
      else throw error;
    }
    return;
  }

  const updateToken = await tokenFor(scope, "update");

  if (state.runningCount <= 0) {
    if (!updateToken) {
      // Started, but the app has not reported its token yet — there is nothing
      // to address an end to. Release so the next run can start cleanly; the
      // client's own 90-second terminal policy retires what is on screen.
      await releaseClaim(scope, state.completedCount, now, "ended without an update token");
      return;
    }
    try {
      await sendLiveActivity(updateToken, liveActivityPayload({
        event: "end",
        now,
        // The final content is what stays on screen for the dismissal window:
        // nothing running, and whatever is still waiting to be read.
        state: { ...state, runningCount: 0, oldestStartedAt: null },
      }));
      await releaseClaim(scope, state.completedCount, now);
    } catch (error) {
      if (error instanceof PushDeliveryError && error.permanent) {
        await disableToken(updateToken.id);
        await releaseClaim(scope, state.completedCount, now, describe(error));
        return;
      }
      throw error;
    }
    return;
  }

  if (claim && materiallyEqual(claim, state)) return;
  // Still `starting`: the awakened app has not handed its token back. The claim
  // keeps the last *sent* content, so binding the token replays the difference.
  if (!updateToken) return;
  try {
    await sendLiveActivity(updateToken, liveActivityPayload({ event: "update", now, state }));
    await recordSent(scope, state, now);
  } catch (error) {
    if (error instanceof PushDeliveryError && error.permanent) {
      await disableToken(updateToken.id);
      await releaseClaim(scope, state.completedCount, now, describe(error));
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function scopesFor(userId: string): Promise<LiveActivityScope[]> {
  const registered = await query<{ device_id: string; connection_id: string }>(
    `SELECT device_id, connection_id FROM live_activity_tokens WHERE user_id=$1 AND disabled_at IS NULL`,
    [userId],
  );
  const claimed = await query<{ device_id: string; connection_id: string }>(
    `SELECT device_id, connection_id FROM live_activity_claims WHERE user_id=$1 AND state <> 'idle'`,
    [userId],
  );
  const scopes = new Map<string, LiveActivityScope>();
  for (const row of [...registered.rows, ...claimed.rows]) {
    scopes.set(`${row.device_id}\0${row.connection_id}`, { userId, deviceId: row.device_id, connectionId: row.connection_id });
  }
  return [...scopes.values()];
}

// One sync at a time per user, in this process. The claim's conditional UPDATE
// is what makes duplicates impossible across processes; this only keeps a busy
// workspace from computing the same aggregate three times in the same tick.
const inFlight = new Map<string, Promise<void>>();

function serialize(key: string, work: () => Promise<void>): Promise<void> {
  const next = (inFlight.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  inFlight.set(key, next);
  void next.catch(() => undefined).then(() => {
    if (inFlight.get(key) === next) inFlight.delete(key);
  });
  return next;
}

export async function syncLiveActivitiesForUser(userId: string): Promise<void> {
  return serialize(userId, async () => {
    const scopes = await scopesFor(userId);
    if (scopes.length === 0) return;
    // Remote start needs a credential to reach APNs through. Without one the
    // registrations are still kept — the client's launch reconciliation works
    // regardless — but nothing is sent.
    if (!fcmEnabled()) return;
    const now = Date.now();
    const state = await liveActivityAggregate(userId, now);
    for (const scope of scopes) {
      await applyToScope(scope, state, now).catch((error) => {
        console.warn("live activity: sync failed:", describe(error));
      });
    }
  });
}

/**
 * Every committed event that can move the aggregate. Ownership rows are the
 * index: the users to refresh are exactly those with attention on the session
 * the event is about.
 */
export async function syncLiveActivitiesForEvent(event: LiveEvent): Promise<void> {
  if (!event.sessionId || (event.kind !== "session" && event.kind !== "attention")) return;
  const { rows } = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM session_attention WHERE peon_id=$1 AND session_id=$2`,
    [event.peonId, event.sessionId],
  );
  for (const row of rows) await syncLiveActivitiesForUser(row.user_id);
}

/**
 * What the client reads on a cold launch to reconcile locally — the same
 * aggregate the push carries, and the registration state per connection. No
 * token ever leaves through here.
 */
export async function liveActivityStatus(userId: string, deviceId: string): Promise<{
  aggregate: LiveActivityContentState;
  remoteStartAvailable: boolean;
  scopes: LiveActivityScopeView[];
}> {
  const aggregate = await liveActivityAggregate(userId);
  const tokens = await query<{ connection_id: string; kind: LiveActivityTokenKind }>(
    `SELECT connection_id, kind FROM live_activity_tokens WHERE user_id=$1 AND device_id=$2 AND disabled_at IS NULL`,
    [userId, deviceId],
  );
  const claims = await query<{ connection_id: string; state: LiveActivityState; activity_id: string | null; running_count: number; completed_count: number; updated_at: number }>(
    `SELECT connection_id, state, activity_id, running_count, completed_count, updated_at
       FROM live_activity_claims WHERE user_id=$1 AND device_id=$2`,
    [userId, deviceId],
  );
  const views = new Map<string, LiveActivityScopeView>();
  const view = (connectionId: string): LiveActivityScopeView => {
    const existing = views.get(connectionId);
    if (existing) return existing;
    const fresh: LiveActivityScopeView = {
      connectionId, state: "idle", activityId: null, hasStartToken: false, hasUpdateToken: false,
      runningCount: 0, completedCount: 0, updatedAt: 0,
    };
    views.set(connectionId, fresh);
    return fresh;
  };
  for (const row of tokens.rows) {
    const entry = view(row.connection_id);
    if (row.kind === "start") entry.hasStartToken = true;
    else entry.hasUpdateToken = true;
  }
  for (const row of claims.rows) {
    const entry = view(row.connection_id);
    entry.state = row.state;
    entry.activityId = row.activity_id;
    entry.runningCount = row.running_count;
    entry.completedCount = row.completed_count;
    entry.updatedAt = row.updated_at;
  }
  return { aggregate, remoteStartAvailable: fcmEnabled(), scopes: [...views.values()] };
}
