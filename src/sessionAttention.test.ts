import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb } from "./db.js";
import { upsertSession } from "./sessionIndex.js";
import {
  completeNextSessionAttention,
  markSessionAttentionRead,
  recordSessionRequest,
  sessionAttentionStates,
} from "./sessionAttention.js";

async function setup() {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
}

test("a completed request stays unread until that user views the session", async () => {
  await setup();
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session", occurrenceKey: "run-1", requestedAt: 10 });
  await completeNextSessionAttention("ws", "peon", "session", 20);
  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, true);
  assert.equal((await sessionAttentionStates("ws", "user-2")).size, 0);

  await markSessionAttentionRead("ws", "user-1", "peon", "session");
  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, false);
});

test("viewing a running request prevents its later completion becoming unread", async () => {
  await setup();
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session", occurrenceKey: "run-1", requestedAt: 10 });
  await markSessionAttentionRead("ws", "user-1", "peon", "session");
  await completeNextSessionAttention("ws", "peon", "session", 20);
  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, false);

  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session", occurrenceKey: "run-2", requestedAt: 30 });
  await completeNextSessionAttention("ws", "peon", "session", 40);
  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, true);
});

test("the session projection completes the pending attention occurrence once", async () => {
  await setup();
  await recordSessionRequest({ workspaceId: "projection-ws", userId: "user-1", peonId: "projection-peon", sessionId: "projection-session", occurrenceKey: "run-1", requestedAt: 10 });
  await upsertSession("projection-ws", "projection-peon", { id: "projection-session", status: "running", lastActivityAt: 11 });
  await upsertSession("projection-ws", "projection-peon", { id: "projection-session", status: "completed", endedAt: 20, lastActivityAt: 20 });
  await upsertSession("projection-ws", "projection-peon", { id: "projection-session", status: "completed", endedAt: 20, lastActivityAt: 20 });
  assert.equal((await sessionAttentionStates("projection-ws", "user-1")).get("projection-peon\0projection-session")?.unread, true);
});
