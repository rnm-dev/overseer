import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { appendEvent } from "../../infrastructure/events/index.js";
import { configureEventDelivery } from "../../app/eventDelivery.js";
import { completeNextSessionAttention, markSessionAttentionRead, recordSessionRequest } from "../sessions/index.js";
import { setPushPreferences, upsertPushSubscription } from "./pushNotifications.js";

// A push is one person's alert about one finished turn, not a mirror of the
// event log. These assert the two halves of that: what gets through, and the
// far larger set of events that must stay silent.

async function setup() {
  configureEventDelivery();
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('u1','push@example.test',1), ('u2','other@example.test',1)`);
  await query(`INSERT INTO devices (id,user_id,token_hash,created_at,expires_at) VALUES ('d1','u1','hash',1,9999999999999), ('d2','u2','hash2',1,9999999999999)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('w1','Push','push',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('w1','u1','owner',1), ('w1','u2','owner',1)`);
  await query(
    `INSERT INTO sessions (peon_id,session_id,status,title,preview,project_key,project_id,raw,synced_at)
     VALUES ('p1','s1','completed','Ship the **deploy**','All three checks passed — see \`npm run verify\`','billing-api','pr1','{}',1)`,
  );
  await query(`INSERT INTO projects (peon_id,project_id,project_key,name,synced_at) VALUES ('p1','pr1','billing-api','Billing API',1)`);
}

async function subscribe(userId: string, deviceId: string, token: string) {
  return upsertPushSubscription({ userId, deviceId, provider: "expo", platform: "ios", token, appId: "dev.overseer" });
}

// The whole trigger: the user asked for a turn, the turn finished, and they
// were not in front of it.
async function finishRequestedTurn(userId = "u1", occurrenceKey = "followup:c1") {
  await recordSessionRequest({ workspaceId: "w1", userId, peonId: "p1", sessionId: "s1", occurrenceKey });
  await completeNextSessionAttention("w1", "p1", "s1", Date.now());
}

async function outbox() {
  const { rows } = await query<{ payload: unknown; subscription_id: string }>(`SELECT payload, subscription_id FROM push_outbox`);
  return rows.map((r) => ({ subscriptionId: r.subscription_id, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload as Record<string, unknown> }));
}

test("a completed user-initiated turn notifies its requester, project first and free of Markdown", async () => {
  await setup();
  const subscription = await subscribe("u1", "d1", "ExponentPushToken[testing-token]");

  await finishRequestedTurn();

  const queued = await outbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].subscriptionId, subscription.id);
  assert.equal(queued[0].payload.title, "Billing API — Ship the deploy");
  assert.equal(queued[0].payload.body, "All three checks passed — see npm run verify");
  assert.deepEqual(queued[0].payload.data, { workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "attention", cursor: queued[0].payload.data.cursor });
});

test("a session with no project keeps a bare title, and an unnamed project falls back to its key", async () => {
  await setup();
  await subscribe("u1", "d1", "ExponentPushToken[testing-token]");
  await query(`UPDATE projects SET name=NULL WHERE peon_id='p1' AND project_id='pr1'`);
  await finishRequestedTurn("u1", "followup:c1");

  await query(`UPDATE sessions SET project_key=NULL, project_id=NULL WHERE peon_id='p1' AND session_id='s1'`);
  await finishRequestedTurn("u1", "followup:c2");

  const titles = (await outbox()).map((row) => row.payload.title);
  assert.deepEqual(titles, ["billing-api — Ship the deploy", "Ship the deploy"]);
});

test("only the requester is told, not everyone in the workspace", async () => {
  await setup();
  await subscribe("u1", "d1", "ExponentPushToken[requester]");
  const bystander = await subscribe("u2", "d2", "ExponentPushToken[bystander]");

  await finishRequestedTurn("u1");

  const queued = await outbox();
  assert.equal(queued.length, 1);
  assert.notEqual(queued[0].subscriptionId, bystander.id);
});

test("an authenticated human mention sends only generic recipient-scoped push copy", async () => {
  await setup();
  const recipient = await subscribe("u1", "d1", "ExponentPushToken[mentioned]");
  await subscribe("u2", "d2", "ExponentPushToken[bystander]");
  await appendEvent({
    workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "mention_attention",
    payload: { peonId: "p1", sessionId: "s1", eventId: "participant_1", recipient: { kind: "user", id: "u1" }, unread: true, updatedAt: Date.now() },
  });
  const queued = await outbox();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].subscriptionId, recipient.id);
  assert.equal(queued[0].payload.body, "You were mentioned in a session");
  assert.equal(JSON.stringify(queued[0].payload).includes("participant_1"), false);
});

test("session, peon and read-receipt events stay silent", async () => {
  await setup();
  await subscribe("u1", "d1", "ExponentPushToken[testing-token]");

  // The firehose: a running session emits one of these per activity tick.
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "session", payload: { title: "Ship the deploy", status: "running" } });
  await appendEvent({ workspaceId: "w1", peonId: "p1", kind: "peon", payload: { name: "Kanat", status: "offline" } });
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "project", payload: { projectKey: "overseer" } });
  // An attention event whose meaning is "already seen".
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "attention", payload: { userId: "u1", peonId: "p1", sessionId: "s1", unread: false, completedAt: 1, updatedAt: 1 } });

  assert.equal((await outbox()).length, 0);
});

test("workspace preferences still switch notifications off", async () => {
  await setup();
  await subscribe("u1", "d1", "ExponentPushToken[testing-token]");
  await setPushPreferences("u1", "w1", { enabled: true, sessionEvents: false, peonEvents: true });

  await finishRequestedTurn();

  assert.equal((await outbox()).length, 0);
});

test("reading the session elsewhere drops a notification that has not gone out yet", async () => {
  await setup();
  await subscribe("u1", "d1", "ExponentPushToken[testing-token]");
  await finishRequestedTurn();
  assert.equal((await outbox()).length, 1);

  await markSessionAttentionRead("w1", "u1", "p1", "s1");

  assert.equal((await outbox()).length, 0);
});

test("a notification already delivered is left alone when the session is read", async () => {
  await setup();
  await subscribe("u1", "d1", "ExponentPushToken[testing-token]");
  await finishRequestedTurn();
  await query(`UPDATE push_outbox SET delivered_at=$1`, [Date.now()]);

  await markSessionAttentionRead("w1", "u1", "p1", "s1");

  assert.equal((await outbox()).length, 1);
});
