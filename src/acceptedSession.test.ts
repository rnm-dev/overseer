import assert from "node:assert/strict";
import test from "node:test";
import { indexAcceptedSession } from "./modules/acceptedSession/index.js";
import { upsertSession } from "./sessionIndex.js";

test("indexes authoritative direct and wrapped accepted session responses", async () => {
  const writes: Array<{ workspaceId: string; peonId: string; session: Parameters<typeof upsertSession>[2] }> = [];
  const write: typeof upsertSession = async (workspaceId, peonId, session) => {
    writes.push({ workspaceId, peonId, session });
  };

  await indexAcceptedSession({ ok: true, json: { id: "direct", status: "running" } }, "workspace", "peon", write);
  await indexAcceptedSession({ ok: true, json: { session: { id: "wrapped", status: "running" } } }, "workspace", "peon", write);

  assert.deepEqual(writes, [
    { workspaceId: "workspace", peonId: "peon", session: { id: "direct", status: "running" } },
    { workspaceId: "workspace", peonId: "peon", session: { id: "wrapped", status: "running" } },
  ]);
});

test("ignores rejected or malformed responses and isolates index failures", async () => {
  let writes = 0;
  const write = async () => { writes += 1; };

  await indexAcceptedSession({ ok: false, json: { id: "rejected" } }, "workspace", "peon", write);
  await indexAcceptedSession({ ok: true, json: { status: "running" } }, "workspace", "peon", write);
  await indexAcceptedSession({ ok: true, json: null }, "workspace", "peon", write);
  await indexAcceptedSession({ ok: true, json: { id: "accepted" } }, "workspace", "peon", async () => {
    writes += 1;
    throw new Error("index unavailable");
  });

  assert.equal(writes, 1);
});
