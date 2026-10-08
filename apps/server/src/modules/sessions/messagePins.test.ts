import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb } from "../../infrastructure/db/index.js";
import { deleteSessionPins, listMessagePins, pinMessage, unpinMessage, validPinEventId } from "./messagePins.js";

 test("pins persist, are idempotent, scoped and bounded, and clean up with the session", async () => {
  const adapter = newDb().adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  const event = { type: "user_message", eventId: "e1", text: "Remember this" };
  assert.equal(await pinMessage("ws", "p", "s", "e1", event, "alice"), true);
  await pinMessage("ws", "p", "s", "e1", { ...event, text: "different" }, "bob");
  const pins = await listMessagePins("ws", "p", "s");
  assert.equal(pins.length, 1);
  assert.equal(pins[0].event.text, "Remember this");
  assert.equal(pins[0].pinnedBy, "alice");
  assert.deepEqual(await listMessagePins("other", "p", "s"), []);
  assert.deepEqual(await listMessagePins("ws", "other", "s"), []);
  assert.deepEqual(await listMessagePins("ws", "p", "other"), []);
  for (let i = 2; i <= 50; i++) await pinMessage("ws", "p", "s", `e${i}`, event, "alice");
  assert.equal(await pinMessage("ws", "p", "s", "overflow", event, "alice"), false);
  await unpinMessage("ws", "p", "s", "e1");
  await unpinMessage("ws", "p", "s", "e1");
  assert.equal(await pinMessage("ws", "p", "s", "overflow", event, "alice"), true);
  await deleteSessionPins("ws", "p", "s");
  assert.deepEqual(await listMessagePins("ws", "p", "s"), []);
 });
 test("pin input is bounded", async () => {
  assert.equal(validPinEventId("../escape"), false);
  assert.equal(validPinEventId("e".repeat(257)), false);
  assert.equal(validPinEventId("evt_123"), true);
  await assert.rejects(pinMessage("w", "p", "s", "e", "x".repeat(131073), "a"), /oversized/);
 });
