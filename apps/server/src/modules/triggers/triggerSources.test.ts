import assert from "node:assert/strict";
import { before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import type { AutomationContext } from "../automation/index.js";
import { fireSource, ingestEvent, sourceStatus, stintPrompt, TriggerSourceError } from "./triggerSources.js";

// A source's events wait until it has been quiet for quietMs, never longer
// than maxMs from the stint's first event (docs/triggers.md).

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
});

const context = (projectKey: string | null = "HB"): AutomationContext => ({
  token: { id: "tok-1" } as AutomationContext["token"],
  record: { peonId: "p1" } as AutomationContext["record"],
  workspaceId: "w1", userId: "u1", role: "owner",
  operator: { email: "o@example.test", githubLogin: null },
  projectKey, projectId: projectKey ? "proj-1" : null,
});
const event = (externalId: string, extra: Record<string, unknown> = {}) =>
  ({ externalId, text: `message ${externalId}`, author: "Aigerim", quietMs: 1_000, maxMs: 5_000, ...extra });

test("each event pushes the deadline out by quietMs, capped at maxMs from the first", async () => {
  const c = context();
  let status = await ingestEvent(c, "chat-1", event("a"), 10_000);
  assert.equal(status.deadlineAt, 11_000);
  status = await ingestEvent(c, "chat-1", event("b"), 10_800);
  assert.equal(status.deadlineAt, 11_800);
  status = await ingestEvent(c, "chat-1", event("c"), 14_700);
  assert.equal(status.deadlineAt, 15_000, "capped at stint start + maxMs");
  assert.equal(status.pendingEvents, 3);
  assert.equal(status.state, "buffering");
});

test("a repeated externalId is a duplicate and changes nothing", async () => {
  const c = context();
  await ingestEvent(c, "chat-2", event("a"), 20_000);
  const again = await ingestEvent(c, "chat-2", event("a"), 20_500);
  assert.equal(again.duplicate, true);
  assert.equal(again.deadlineAt, 21_000);
  assert.equal(again.pendingEvents, 1);
});

test("bad input is refused, and a Peon-scoped token cannot own a source", async () => {
  await assert.rejects(ingestEvent(context(), "has space", event("a")), TriggerSourceError);
  await assert.rejects(ingestEvent(context(), "chat-3", { externalId: "x", text: "  " }), TriggerSourceError);
  await assert.rejects(ingestEvent(context(), "chat-3", event("a", { quietMs: -1 })), TriggerSourceError);
  await assert.rejects(ingestEvent(context(null), "chat-3", event("a")), TriggerSourceError);
});

test("a due source whose key no longer resolves keeps its events and stops", async () => {
  const c = context();
  await ingestEvent(c, "chat-4", event("a"), 30_000);
  const { rows: due } = await query(`SELECT * FROM trigger_sources WHERE source_id='chat-4'`);
  await fireSource(due[0] as Parameters<typeof fireSource>[0], 40_000);
  const status = await sourceStatus(c, "chat-4");
  assert.equal(status.state, "idle", String(status.lastError));
  assert.equal(status.pendingEvents, 1);
  assert.match(status.lastError ?? "", /UNAUTHENTICATED/);
  const { rows } = await query(`SELECT delivered_as FROM trigger_source_events`);
  assert.ok(rows.length > 0);
});

test("a stint lists every message in order, untruncated", () => {
  const long = "x".repeat(50_000);
  const prompt = stintPrompt("chat-9", [
    { author: "A", text: "first", at: 0 },
    { author: null, text: long, at: 60_000 },
  ]);
  assert.match(prompt, /^New messages from source chat-9 \(2\):/);
  assert.ok(prompt.indexOf("A: first") < prompt.indexOf("unknown: "));
  assert.ok(prompt.includes(long));
});
