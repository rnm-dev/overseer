import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import { addUserMessageMetadata, enrichTranscriptMetadata } from "./transcriptTimestamps.js";

test("adds known user-message timestamps in transcript order", () => {
  const original = [
    { type: "user_message", text: "start" },
    { type: "assistant", text: "working" },
    { type: "user_message", text: "again" },
    { type: "user_message", text: "again" },
  ];
  assert.deepEqual(addUserMessageMetadata(original, [
    { text: "start", createdAt: 100 },
    { text: "again", createdAt: 200, commandId: "command-1" },
    { text: "again", createdAt: 300, commandId: "command-2" },
  ]), [
    { type: "user_message", text: "start", createdAt: 100 },
    { type: "assistant", text: "working" },
    { type: "user_message", text: "again", createdAt: 200, commandId: "command-1" },
    { type: "user_message", text: "again", createdAt: 300, commandId: "command-2" },
  ]);
});

test("preserves Peon timestamps and leaves unmatched messages unchanged", () => {
  const stamped = { type: "user_message", text: "native", createdAt: 55 };
  const unmatched = { type: "user_message", text: "unknown" };
  assert.deepEqual(addUserMessageMetadata([stamped, unmatched], [{ text: "native", createdAt: 99 }]), [stamped, unmatched]);
});

test("normalizes message author to email while preserving separate identity fields", () => {
  const events = [
    { type: "user_message", text: "from login", author: "vibze" },
    { type: "user_message", text: "from email", author: "viktor.ten@me.com" },
  ];
  const identity = [{ email: "viktor.ten@me.com", githubLogin: "vibze", avatarUrl: "https://avatars.example/vibze.png" }];
  assert.deepEqual(addUserMessageMetadata(events, [], identity), [
    { type: "user_message", text: "from login", author: "viktor.ten@me.com", authorEmail: "viktor.ten@me.com", authorGithubLogin: "vibze", authorAvatarUrl: "https://avatars.example/vibze.png" },
    { type: "user_message", text: "from email", author: "viktor.ten@me.com", authorEmail: "viktor.ten@me.com", authorGithubLogin: "vibze", authorAvatarUrl: "https://avatars.example/vibze.png" },
  ]);
});

test("enrichment timestamps the first user message without a cached full prompt", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO sessions (peon_id, session_id, started_at, raw, synced_at) VALUES ($1, $2, $3, $4, $5)`,
    ["peon", "session", 1234, JSON.stringify({ id: "session", promptPreview: "opening req" }), 1],
  );

  assert.deepEqual(await enrichTranscriptMetadata("peon", "session", [
    { type: "assistant", text: "booting" },
    { type: "user_message", text: "opening request" },
  ]), [
    { type: "assistant", text: "booting" },
    { type: "user_message", text: "opening request", createdAt: 1234 },
  ]);
});
