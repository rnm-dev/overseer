import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb } from "./db.js";
import {
  applySocketSessionEvent,
  applySocketSessionSnapshot,
  claimSessionSyncGeneration,
  upsertSession,
} from "./sessionIndex.js";
import {
  completeNextSessionAttention,
  markSessionAttentionRead,
  recordSessionRequest,
  sessionAttentionStates,
} from "./sessionAttention.js";
import { heartbeatPresence, removePresence } from "./modules/presence/index.js";

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

// Viewing a session marks its occurrence read but leaves it uncompleted, so a
// long-lived session accumulates read occurrences. They must never absorb the
// completion that belongs to a request the user has not seen finish.
test("read occurrences never absorb a later request's completion", async () => {
  await setup();
  for (const [index, requestedAt] of [10, 20, 30].entries()) {
    await recordSessionRequest({
      workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session",
      occurrenceKey: `seen-${index}`, requestedAt,
    });
  }
  await markSessionAttentionRead("ws", "user-1", "peon", "session");
  await recordSessionRequest({
    workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session",
    occurrenceKey: "fresh", requestedAt: 40,
  });

  await completeNextSessionAttention("ws", "peon", "session", 50);

  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, true);
});

// Peons deliver every session update over the durable socket catalog, so the
// unread state has to come off that path — not only off the legacy upsert.
test("a run completed over the socket session catalog turns the request unread", async () => {
  await setup();
  await claimSessionSyncGeneration("socket-peon", "generation");
  await applySocketSessionSnapshot({
    workspaceId: "socket-ws", peonId: "socket-peon", generation: "generation",
    catalogEpoch: "catalog", barrierSeq: 0, deliveryEpoch: "delivery", acknowledgedCursor: null,
    sessions: [{ id: "socket-session", status: "running", lastActivityAt: 11 }],
  });
  await recordSessionRequest({
    workspaceId: "socket-ws", userId: "user-1", peonId: "socket-peon",
    sessionId: "socket-session", occurrenceKey: "run-1", requestedAt: 10,
  });
  await applySocketSessionEvent({
    workspaceId: "socket-ws", peonId: "socket-peon", generation: "generation",
    catalogEpoch: "catalog", seq: 1, deliveryEpoch: "delivery", deliveryCursor: "cursor-1",
    messageId: "00000000-0000-4000-8000-000000000010", operation: "upsert",
    session: { id: "socket-session", status: "completed", endedAt: 20, lastActivityAt: 20 },
  });

  assert.equal((await sessionAttentionStates("socket-ws", "user-1")).get("socket-peon\0socket-session")?.unread, true);
});

test("the session projection completes the pending attention occurrence once", async () => {
  await setup();
  await recordSessionRequest({ workspaceId: "projection-ws", userId: "user-1", peonId: "projection-peon", sessionId: "projection-session", occurrenceKey: "run-1", requestedAt: 10 });
  await upsertSession("projection-ws", "projection-peon", { id: "projection-session", status: "running", lastActivityAt: 11 });
  await upsertSession("projection-ws", "projection-peon", { id: "projection-session", status: "completed", endedAt: 20, lastActivityAt: 20 });
  await upsertSession("projection-ws", "projection-peon", { id: "projection-session", status: "completed", endedAt: 20, lastActivityAt: 20 });
  assert.equal((await sessionAttentionStates("projection-ws", "user-1")).get("projection-peon\0projection-session")?.unread, true);
});

test("a completion never raises unread on a session the requester is watching", async () => {
  await setup();
  removePresence("ws", "user-1", "conn-1");
  heartbeatPresence({
    connectionId: "conn-1",
    workspaceId: "ws",
    userId: "user-1",
    email: "user-1@example.com",
    githubLogin: null,
    avatarUrl: null,
    scope: "session",
    peonId: "peon",
    sessionId: "session",
    projectKey: null,
    projectId: null,
  });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session", occurrenceKey: "run-1", requestedAt: 10 });
  await completeNextSessionAttention("ws", "peon", "session", 20);
  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, false);

  // A backgrounded tab keeps its route presence but is not "in front of" the
  // session, so its completion must still raise the amber edge.
  heartbeatPresence({
    connectionId: "conn-1",
    workspaceId: "ws",
    userId: "user-1",
    email: "user-1@example.com",
    githubLogin: null,
    avatarUrl: null,
    scope: "session",
    peonId: "peon",
    sessionId: "session",
    projectKey: null,
    projectId: null,
    active: false,
  });
  await recordSessionRequest({ workspaceId: "ws", userId: "user-1", peonId: "peon", sessionId: "session", occurrenceKey: "run-2", requestedAt: 30 });
  await completeNextSessionAttention("ws", "peon", "session", 40);
  assert.equal((await sessionAttentionStates("ws", "user-1")).get("peon\0session")?.unread, true);
  removePresence("ws", "user-1", "conn-1");
});
