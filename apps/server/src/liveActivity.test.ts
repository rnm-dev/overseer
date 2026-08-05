import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "./infrastructure/config/index.js";
import { initDb, query } from "./infrastructure/db/index.js";
import { appendEvent } from "./infrastructure/events/index.js";
import { configureEventDelivery } from "./app/eventDelivery.js";
import { appleDate } from "./infrastructure/push/index.js";
import {
  aggregateActivityId,
  bindLiveActivityUpdateToken,
  liveActivityAggregate,
  registerLiveActivityStartToken,
} from "./liveActivity.js";
import { completeNextSessionAttention, recordSessionRequest } from "./modules/sessions/index.js";
import { createServer } from "./server.js";

// One Live Activity per operator per device connection, counting everything that
// operator has running anywhere. These assert that invariant from the outside:
// what APNs actually receives as sessions start and finish, and that the
// registration contract asks for a connection, never for a session.
//
// The claim is the thing worth guarding. A second `start` where an `update`
// belonged is two activities on one lock screen; an `end` while a run is still
// going is a counter that vanishes mid-work.

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = {
  projectId: "overseer-test",
  clientEmail: "fcm@overseer-test.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  tokenUri: "https://oauth2.googleapis.com/token",
};

const DEVICE_TOKEN = "d1.secret-1";
const CONNECTION = "conn-1";
const START_TOKEN = "start-token-0123456789abcdef";
const UPDATE_TOKEN = "update-token-0123456789abcdef";
const FCM_TOKEN = "fcm-registration-token-0123456789";

interface Delivered {
  token: string;
  recipient: string | null;
  topic: string | null;
  event: string;
  state: { runningCount: number; completedCount: number; oldestStartedAt: number | null; updatedAt: number | null };
  attributes: Record<string, unknown> | null;
  alert: Record<string, unknown> | null;
  dismissal: number | null;
}

let server: http.Server;
let port: number;
let sent: Delivered[] = [];
const realFetch = globalThis.fetch;
const originalPush = config.push;

// Everything Google would answer, answered here: the token exchange and the
// send. The Live Activity payload is read back off the wire rather than out of
// the builder, because "what APNs received" is the assertion that matters.
function record(body: string): void {
  const message = (JSON.parse(body) as { message: { token?: string; apns: { liveActivityToken: string; headers: Record<string, string>; payload: { aps: Record<string, unknown> } } } }).message;
  const aps = message.apns.payload.aps;
  const state = aps["content-state"] as Delivered["state"];
  sent.push({
    token: message.apns.liveActivityToken,
    recipient: message.token ?? null,
    topic: message.apns.headers["apns-topic"] ?? null,
    event: String(aps.event),
    state,
    attributes: (aps.attributes as Record<string, unknown> | undefined) ?? null,
    alert: (aps.alert as Record<string, unknown> | undefined) ?? null,
    dismissal: (aps["dismissal-date"] as number | undefined) ?? null,
  });
}

before(async () => {
  config.push = { fcm: ACCOUNT, warnings: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`http://127.0.0.1:${port}`)) return realFetch(input, init);
    if (url === ACCOUNT.tokenUri) return Response.json({ access_token: "access-token", expires_in: 3600 });
    if (url.endsWith("messages:send")) {
      record(String(init?.body));
      return Response.json({ name: "projects/overseer-test/messages/1" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;
  server = http.createServer(createServer());
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  globalThis.fetch = realFetch;
  config.push = originalPush;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  configureEventDelivery();
  sent = [];
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('u1','operator@example.test',1), ('u2','other@example.test',1)`);
  await query(`INSERT INTO devices (id,user_id,token_hash,created_at,expires_at) VALUES ('d1','u1',$1,1,9999999999999), ('d2','u2','hash-2',1,9999999999999)`, [
    createHash("sha256").update("secret-1").digest("hex"),
  ]);
  // The device's ordinary FCM registration. It is not decoration: FCM will not
  // accept a Live Activity push that does not name an app instance.
  await query(
    `INSERT INTO push_subscriptions (id,user_id,device_id,provider,platform,token,app_id,created_at,updated_at)
     VALUES ('sub-1','u1','d1','fcm','ios',$1,'dev.overseer',1,1)`,
    [FCM_TOKEN],
  );
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('w1','Fleet','fleet',1), ('w2','Second','second',1)`);
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ('w1','u1','owner',1), ('w2','u1','owner',1), ('w1','u2','owner',1)`,
  );
});

async function indexSession(sessionId: string, startedAt: number, status = "running", peonId = "p1"): Promise<void> {
  await query(
    `INSERT INTO sessions (peon_id,session_id,status,started_at,last_activity_at,raw,synced_at)
     VALUES ($1,$2,$3,$4,$4,'{}',$4)`,
    [peonId, sessionId, status, startedAt],
  );
}

async function finish(sessionId: string, at: number, workspaceId = "w1", peonId = "p1"): Promise<void> {
  await query(`UPDATE sessions SET status='completed', last_activity_at=$3 WHERE peon_id=$1 AND session_id=$2`, [peonId, sessionId, at]);
  await completeNextSessionAttention(workspaceId, peonId, sessionId, at);
}

const start = () => registerLiveActivityStartToken({ userId: "u1", deviceId: "d1", connectionId: CONNECTION, token: START_TOKEN, bundleId: "dev.overseer" });

// The far side of a push-to-start: ActivityKit created the aggregate and the app
// hands back the token that addresses it.
const bind = () => bindLiveActivityUpdateToken({
  userId: "u1", deviceId: "d1", connectionId: CONNECTION,
  activityId: aggregateActivityId(CONNECTION), token: UPDATE_TOKEN, bundleId: "dev.overseer",
});

test("one aggregate starts, counts every running session, and ends only when the last finishes", async () => {
  await start();
  assert.equal(sent.length, 0, "an operator with nothing running has no activity to start");

  await indexSession("s1", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 1_000 });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "start");
  assert.equal(sent[0].token, START_TOKEN, "a start is addressed to the push-to-start token, not to an activity");
  assert.equal(sent[0].recipient, FCM_TOKEN, "FCM refuses a message that names no app instance, activity token or not");
  assert.equal(sent[0].topic, "dev.overseer.push-type.liveactivity");
  assert.equal(sent[0].state.runningCount, 1);
  assert.equal(sent[0].state.oldestStartedAt, appleDate(1_000));
  assert.deepEqual(sent[0].attributes, { activityId: "overseer:conn-1", connectionId: CONNECTION });
  assert.ok(sent[0].alert, "Apple requires a visible alert on a push-to-start");

  await bind();
  assert.equal(sent.length, 1, "binding the token replays nothing the start already carried");

  // A second run on the same connection is an update to the one aggregate.
  await indexSession("s2", 2_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s2", occurrenceKey: "create:2", requestedAt: 2_000 });

  assert.equal(sent.length, 2);
  assert.equal(sent[1].event, "update");
  assert.equal(sent[1].token, UPDATE_TOKEN);
  assert.equal(sent[1].state.runningCount, 2);
  assert.equal(sent[1].state.oldestStartedAt, appleDate(1_000), "the aggregate ages from the oldest run, not the newest");
  assert.equal(sent[1].alert, null, "an update must not buzz the phone");

  // One of two finishing moves the counters; it does not retire the activity.
  await finish("s1", 3_000);

  assert.equal(sent.length, 3);
  assert.equal(sent[2].event, "update");
  assert.equal(sent[2].state.runningCount, 1);
  assert.equal(sent[2].state.completedCount, 1);
  assert.equal(sent[2].state.oldestStartedAt, appleDate(2_000));

  await finish("s2", 4_000);

  assert.equal(sent.length, 4);
  assert.equal(sent[3].event, "end");
  assert.equal(sent[3].token, UPDATE_TOKEN);
  assert.equal(sent[3].state.runningCount, 0);
  assert.equal(sent[3].state.completedCount, 2, "what is still unread stays on screen for the dismissal window");
  assert.equal(sent[3].state.oldestStartedAt, null);
  assert.ok(sent[3].dismissal, "an end carries its own dismissal deadline in case the app never runs again");

  assert.equal(sent.filter((push) => push.event === "start").length, 1, "one connection, one activity");
});

test("running sessions in different workspaces share the operator's one aggregate", async () => {
  await start();
  await indexSession("w1-session", 1_000);
  await indexSession("w2-session", 2_000, "running", "p2");
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "w1-session", occurrenceKey: "create:1", requestedAt: 1_000 });
  await bind();
  await recordSessionRequest({ workspaceId: "w2", userId: "u1", peonId: "p2", sessionId: "w2-session", occurrenceKey: "create:2", requestedAt: 2_000 });

  assert.deepEqual(sent.map((push) => [push.event, push.state.runningCount]), [["start", 1], ["update", 2]]);

  // Emptying one workspace is not emptying the operator: the aggregate spans them.
  await finish("w1-session", 3_000);
  assert.deepEqual(sent.at(-1)?.event, "update");
  assert.equal(sent.at(-1)?.state.runningCount, 1);

  await finish("w2-session", 4_000, "w2", "p2");
  assert.equal(sent.at(-1)?.event, "end");
  assert.equal(await liveActivityAggregate("u1", 5_000).then((state) => state.runningCount), 0);
});

test("a redelivered event neither doubles the activity nor moves the counters", async () => {
  await start();
  await indexSession("s1", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 1_000 });
  await bind();
  assert.deepEqual(sent.map((push) => push.event), ["start"]);

  // The same request arriving twice — a retried command, a replayed frame. The
  // occurrence is keyed, so the aggregate is recomputed to the same answer.
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 1_000 });
  // And the session's own firehose, which says nothing new about the counts.
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "session", payload: { status: "running" } });
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "session", payload: { status: "running" } });

  assert.deepEqual(sent.map((push) => push.event), ["start"], "an aggregate that has not moved is not worth a push");
  assert.equal((await liveActivityAggregate("u1", 2_000)).runningCount, 1);

  // A completion delivered twice must not end an activity that is still counting
  // the second run, nor count the same finish twice.
  await indexSession("s2", 2_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s2", occurrenceKey: "create:2", requestedAt: 2_000 });
  await finish("s1", 3_000);
  await completeNextSessionAttention("w1", "p1", "s1", 3_000);

  assert.deepEqual(sent.map((push) => push.event), ["start", "update", "update"]);
  assert.equal(sent.at(-1)?.state.runningCount, 1);
  assert.equal(sent.at(-1)?.state.completedCount, 1, "one finish, counted once");
});

test("another operator's run never enters my aggregate", async () => {
  await start();
  await indexSession("theirs", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u2", peonId: "p1", sessionId: "theirs", occurrenceKey: "create:1", requestedAt: 1_000 });

  assert.equal(sent.length, 0, "u2 has no registration, and their run is not u1's to count");
  assert.equal((await liveActivityAggregate("u1", 2_000)).runningCount, 0);

  // A follow-up of mine into their session makes it mine to watch, once.
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "theirs", occurrenceKey: "followup:2", requestedAt: 2_000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.runningCount, 1);
});

test("after the last run ends, the next one starts a fresh aggregate", async () => {
  await start();
  await indexSession("first", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "first", occurrenceKey: "create:1", requestedAt: 1_000 });
  await bind();
  await finish("first", 2_000);
  assert.equal(sent.at(-1)?.event, "end");

  // The update token died with the activity it addressed; the claim is idle, so
  // the next run has to go through push-to-start again.
  await indexSession("second", 3_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "second", occurrenceKey: "create:2", requestedAt: 3_000 });

  assert.equal(sent.at(-1)?.event, "start");
  assert.equal(sent.at(-1)?.token, START_TOKEN);
  assert.equal(sent.at(-1)?.state.runningCount, 1);
  assert.equal(sent.at(-1)?.state.completedCount, 1, "the finished run is still unread, and says so");
});

test("a device with no FCM registration has no delivery path, and is left alone", async () => {
  // The app installed, signed in and registered its ActivityKit token, but its
  // ordinary push registration is gone — revoked, rotated, never granted. FCM
  // would refuse the message, so nothing is attempted and no claim is taken.
  await query(`UPDATE push_subscriptions SET disabled_at=2 WHERE user_id='u1'`);
  await start();
  await indexSession("s1", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 1_000 });

  assert.equal(sent.length, 0);
  const { rows } = await query<{ state: string }>(`SELECT state FROM live_activity_claims WHERE user_id='u1'`);
  assert.equal(rows[0]?.state ?? "idle", "idle", "a claim taken here would block the start that becomes possible later");

  // Registering the phone for push again is all it takes.
  await query(`UPDATE push_subscriptions SET disabled_at=NULL WHERE user_id='u1'`);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "followup:2", requestedAt: 2_000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, "start");
});

test("a connection with no push-to-start token is left to reconcile at launch", async () => {
  await indexSession("s1", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 1_000 });

  assert.equal(sent.length, 0, "there is no way to start an activity remotely, and a notification is not a substitute");
  assert.equal((await liveActivityAggregate("u1", 2_000)).runningCount, 1, "the aggregate the app will read at launch is still right");
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await realFetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

test("registration is scoped to a connection, and needs no session identity", async () => {
  const startToken = await api("PUT", "/push/live-activities/start-token", { connectionId: CONNECTION, token: START_TOKEN, appId: "dev.overseer" });
  assert.equal(startToken.status, 201, "a push-to-start token belongs to a device connection, not to a session");
  assert.deepEqual(startToken.body, { connectionId: CONNECTION, kind: "start" });

  const updateToken = await api("PUT", "/push/live-activities", { connectionId: CONNECTION, activityId: aggregateActivityId(CONNECTION), token: UPDATE_TOKEN });
  assert.equal(updateToken.status, 201);
  assert.deepEqual(updateToken.body, { connectionId: CONNECTION, activityId: "overseer:conn-1", kind: "update" });

  const missing = await api("PUT", "/push/live-activities", { activityId: aggregateActivityId(CONNECTION), token: UPDATE_TOKEN });
  assert.equal(missing.status, 400, "the connection is the identity — without it there is nothing to bind to");
  assert.equal(missing.body.code, "BAD_LIVE_ACTIVITY_TOKEN");
});

test("status reports the aggregate and the registration, and never a token", async () => {
  await indexSession("s1", 1_000);
  await recordSessionRequest({ workspaceId: "w1", userId: "u1", peonId: "p1", sessionId: "s1", occurrenceKey: "create:1", requestedAt: 1_000 });
  await api("PUT", "/push/live-activities/start-token", { connectionId: CONNECTION, token: START_TOKEN, appId: "dev.overseer" });
  await api("PUT", "/push/live-activities", { connectionId: CONNECTION, activityId: aggregateActivityId(CONNECTION), token: UPDATE_TOKEN });

  const status = await api("GET", "/push/live-activities");
  assert.equal(status.status, 200);
  const body = status.body as unknown as { aggregate: { runningCount: number }; remoteStartAvailable: boolean; scopes: Array<Record<string, unknown>> };
  assert.equal(body.aggregate.runningCount, 1);
  assert.equal(body.remoteStartAvailable, true);
  assert.equal(body.scopes.length, 1);
  assert.equal(body.scopes[0].connectionId, CONNECTION);
  assert.equal(body.scopes[0].hasStartToken, true);
  assert.equal(body.scopes[0].hasUpdateToken, true);
  assert.equal(body.scopes[0].state, "active");
  assert.ok(!JSON.stringify(status.body).includes(START_TOKEN) && !JSON.stringify(status.body).includes(UPDATE_TOKEN), "a token is write-only to the server");

  const gone = await api("DELETE", "/push/live-activities", { connectionId: CONNECTION });
  assert.equal(gone.status, 200);
  const after = await api("GET", "/push/live-activities");
  const scopes = (after.body as unknown as { scopes: Array<Record<string, unknown>> }).scopes;
  assert.equal(scopes[0].hasUpdateToken, false, "the client reporting its activity gone releases the claim");
  assert.equal(scopes[0].state, "idle");
});
