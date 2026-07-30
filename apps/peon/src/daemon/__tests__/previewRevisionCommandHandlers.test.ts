import assert from "node:assert/strict";
import test from "node:test";
import { previewRevisionCommandHandlers } from "../overseer/socket/channels/previewRevisionCommandHandlers.js";
import type { ValidCommand } from "../overseer/socket/channels/reverseCommandChannel.js";

const leaseId = "00000000-0000-4000-8000-000000000001";
const command = (operation: string, payload: Record<string, unknown>, actorId = "actor"): ValidCommand => ({
  commandId: "00000000-0000-4000-8000-000000000002",
  operation,
  target: { peonId: "peon", sessionId: "session" },
  actor: { userId: actorId, email: `${actorId}@example.com` },
  payload,
  expected: null,
  requestedAt: 1,
});

test("routes watch, monotonic renew and unwatch through one publisher", async () => {
  const calls: string[] = [];
  const publisher = {
    watch: async () => { calls.push("watch"); },
    renew: () => { calls.push("renew"); return true; },
    unwatch: () => { calls.push("unwatch"); return true; },
  };
  const handlers = previewRevisionCommandHandlers({
    publisher: publisher as never,
    sessions: { get: () => ({ id: "session", dir: "/tmp/session" }) as never },
    negotiated: () => true,
    now: () => 100,
  });
  const watch = command("preview.watch", { leaseId, path: "report.html", expiresAt: 200 });
  assert.equal(handlers["preview.watch"]?.validate(watch.payload, null, watch), null);
  assert.equal((await handlers["preview.watch"]?.execute(watch))?.status, "applied");
  assert.equal((await handlers["preview.watch"]?.execute(watch))?.status, "noop");
  assert.equal((await handlers["preview.renew"]?.execute(command("preview.renew", { leaseId, expiresAt: 250 })))?.status, "applied");
  assert.equal((await handlers["preview.unwatch"]?.execute(command("preview.unwatch", { leaseId })))?.status, "applied");
  assert.deepEqual(calls, ["watch", "renew", "unwatch"]);
});

test("fails closed without negotiation and does not allow another actor to release a lease", async () => {
  let unwatch = 0;
  const publisher = {
    watch: async () => {},
    renew: () => true,
    unwatch: () => { unwatch += 1; return true; },
  };
  let negotiated = false;
  const handlers = previewRevisionCommandHandlers({
    publisher: publisher as never,
    sessions: { get: () => ({ id: "session", dir: "/tmp/session" }) as never },
    negotiated: () => negotiated,
    now: () => 100,
  });
  const watch = command("preview.watch", { leaseId, path: "report.html", expiresAt: 200 });
  assert.equal((await handlers["preview.watch"]?.execute(watch))?.code, "UNSUPPORTED_CAPABILITY");
  negotiated = true;
  assert.equal((await handlers["preview.watch"]?.execute(watch))?.status, "applied");
  assert.equal((await handlers["preview.unwatch"]?.execute(command("preview.unwatch", { leaseId }, "other")))?.status, "noop");
  assert.equal(unwatch, 0);
});
