import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query, transaction } from "../../infrastructure/db/index.js";
import { assertProjectionGeneration, projectionFreshness, readDeliveryCheckpoint, recordDurableInbox } from "./projectionCore.js";

test("projection freshness never treats an offline cached row as fresh", () => {
  assert.equal(projectionFreshness({ online: false, receivedAt: 0, now: 1, staleAfterMs: 10 }), "offline");
  assert.equal(projectionFreshness({ online: true, receivedAt: 10, now: 20, staleAfterMs: 10 }), "fresh");
  assert.equal(projectionFreshness({ online: true, receivedAt: 10, now: 21, staleAfterMs: 10 }), "stale");
});

test("durable inbox rejects a cursor/message identity collision before an ACK checkpoint can advance", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO peon_session_sync (peon_id,status,updated_at,generation) VALUES ('p','syncing',1,'g')`);

  await transaction(async (tx) => {
    await assertProjectionGeneration(tx, "p", "g", ["peon_session_sync"]);
    assert.equal(await recordDurableInbox(tx, {
      peonId: "p", deliveryEpoch: "delivery", deliveryCursor: "1", messageId: "message-1",
    }), "inserted");
  });
  await assert.rejects(
    () => transaction((tx) => recordDurableInbox(tx, {
      peonId: "p", deliveryEpoch: "delivery", deliveryCursor: "1", messageId: "different-message",
    })),
    /replay identity mismatch/,
  );
  assert.equal(await transaction((tx) => readDeliveryCheckpoint(tx, "p", "g")), null);
});

test("generation fences reject a replacement before it can write an inbox row", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO peon_session_sync (peon_id,status,updated_at,generation) VALUES ('p','syncing',1,'new')`);
  await assert.rejects(
    () => transaction((tx) => assertProjectionGeneration(tx, "p", "old", ["peon_session_sync"])),
    /projection sync connection was replaced/,
  );
  assert.equal(Number((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count), 0);
});

test("delivery checkpoint preserves an epoch whose cumulative cursor is still null", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO peon_session_sync
    (peon_id,status,updated_at,generation,delivery_epoch,acknowledged_cursor)
    VALUES ('p','syncing',1,'g','delivery',NULL)`);
  assert.deepEqual(await transaction((tx) => readDeliveryCheckpoint(tx, "p", "g")), {
    epoch: "delivery",
    acknowledgedCursor: null,
  });
});
