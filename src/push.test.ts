import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import { appendEvent } from "./eventLog.js";
import { setPushPreferences, upsertPushSubscription } from "./push.js";

async function setup() {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('u1','push@example.test',1)`);
  await query(`INSERT INTO devices (id,user_id,token_hash,created_at,expires_at) VALUES ('d1','u1','hash',1,9999999999999)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('w1','Push','push',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('w1','u1','owner',1)`);
}

test("durable events enqueue Expo pushes and respect workspace preferences", async () => {
  await setup();
  await upsertPushSubscription({ userId: "u1", deviceId: "d1", provider: "expo", platform: "ios", token: "ExponentPushToken[testing-token]", appId: "dev.overseer" });
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "session", payload: { title: "Build", status: "complete" } });
  assert.equal((await query(`SELECT id FROM push_outbox`)).rowCount, 1);

  await setPushPreferences("u1", "w1", { enabled: true, sessionEvents: false, peonEvents: true });
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s2", kind: "session", payload: { status: "complete" } });
  assert.equal((await query(`SELECT id FROM push_outbox`)).rowCount, 1);
});

// A registered FCM device on an instance with no service account has nowhere to
// deliver to. Queueing for it anyway would build a backlog that only ever fails,
// so the subscription is simply skipped until the credential exists.
test("an FCM subscription queues nothing while no service account is configured", async () => {
  await setup();
  await upsertPushSubscription({ userId: "u1", deviceId: "d1", provider: "fcm", platform: "android", token: "fcm-registration-token-abcdef", appId: "dev.overseer" });
  await appendEvent({ workspaceId: "w1", peonId: "p1", sessionId: "s1", kind: "session", payload: { title: "Build", status: "complete" } });
  assert.equal((await query(`SELECT id FROM push_outbox`)).rowCount, 0);
});
