import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { bus, type LiveEvent } from "../../infrastructure/events/index.js";
import { eventVisible, type AccessClient } from "../access/index.js";
import {
  ensureDirectSessionParticipant,
  listMentionAttention,
  markMentionAttentionRead,
  mentionPrincipals,
  recordMentionAttention,
  resolveMentions,
  validateContextText,
  validateMentionInputs,
} from "./index.js";

async function setup() {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,github_login,created_at) VALUES ('author','author@example.test','author',1),('recipient','recipient@example.test','viktor',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ('ws','Workspace','workspace','author',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('ws','author','owner',1),('ws','recipient','member',1)`);
  await ensureDirectSessionParticipant("ws", "peon", "session", { userId: "author", email: "author@example.test", githubLogin: "author", avatarUrl: null, deviceId: "a" });
  await ensureDirectSessionParticipant("ws", "peon", "session", { userId: "recipient", email: "recipient@example.test", githubLogin: "viktor", avatarUrl: null, deviceId: "r" });
}

test("mention validation uses ordered UTF-16 ranges and authority labels", async () => {
  await setup();
  const text = "😀 @old please check";
  assert.equal(validateContextText(text), text);
  assert.throws(() => validateMentionInputs(text, [{ startUtf16: 1, lengthUtf16: 2, principal: { kind: "user", id: "recipient" } }]), /range/u);
  const resolved = await resolveMentions("ws", "peon", "session", text, [{ startUtf16: 3, lengthUtf16: 4, principal: { kind: "user", id: "recipient" } }]);
  assert.equal(resolved?.[0]?.principal.label, "viktor");
  assert.deepEqual((await mentionPrincipals("ws", "peon", "session")).map((principal) => principal.id), ["author", "recipient"]);
});

test("attention is idempotent, author-excluding, exact-read, and recipient-scoped", async () => {
  await setup();
  const emitted: LiveEvent[] = [];
  const listener = (event: LiveEvent) => { if (event.kind === "mention_attention") emitted.push(event); };
  bus.on("event", listener);
  const event = {
    type: "participant_message", eventId: "participant_1",
    author: { kind: "user", id: "author", label: "author" },
    mentions: [
      { startUtf16: 0, lengthUtf16: 7, principal: { kind: "user", id: "recipient", label: "viktor" } },
      { startUtf16: 8, lengthUtf16: 7, principal: { kind: "user", id: "recipient", label: "viktor" } },
      { startUtf16: 16, lengthUtf16: 7, principal: { kind: "user", id: "author", label: "author" } },
    ],
  };
  await recordMentionAttention("ws", "peon", "session", event);
  await recordMentionAttention("ws", "peon", "session", event);
  assert.equal((await listMentionAttention("ws", "peon", "session", { kind: "user", id: "recipient" })).length, 1);
  assert.equal(emitted.length, 1);
  const client: AccessClient = { userId: "recipient", workspaceId: "ws", role: "member", allowedPeons: new Set(["peon"]), allowedProjects: new Map(), tails: new Map() };
  assert.equal(eventVisible(client, emitted[0]!), true);
  assert.equal(eventVisible({ ...client, userId: "author" }, emitted[0]!), false);
  await markMentionAttentionRead("ws", "peon", "session", { kind: "user", id: "recipient" }, ["participant_1", "unknown"]);
  assert.equal((await listMentionAttention("ws", "peon", "session", { kind: "user", id: "recipient" })).length, 0);
  assert.equal(emitted.length, 2);
  bus.off("event", listener);
});
