import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DaemonConfigurationState } from "../settings/daemonConfigurationState.js";
import { DaemonConfigurationChannel } from "../overseer/socket/channels/daemonConfigurationChannel.js";
import { settings } from "../settings/index.js";
import { SettingsService } from "../settings/settingsService.js";
import { SettingsStore } from "../settings/settingsStore.js";
import type { PeonSocketFrame, PeonSocketSender } from "../overseer/socket/peonSocketProtocol.js";

function sender(frames: PeonSocketFrame[]): PeonSocketSender {
  let cursor = 0;
  return {
    durable: true,
    authority: "a".repeat(64),
    generation: 1,
    send: () => true,
    sendBinary: () => true,
    sendDurable: (frame, options) => {
      frames.push({ frame, options });
      cursor += 1;
      return { accepted: true, epoch: "delivery", cursor: String(cursor).padStart(16, "0"), messageId: randomUUID() };
    },
    disconnect: (reason) => { throw new Error(reason); },
  };
}

test("daemon configuration negotiates exact checkpoints and publishes only the safe document", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-config-channel-"));
  const state = new DaemonConfigurationState(path.join(root, "state.json"), () => 123);
  const channel = new DaemonConfigurationChannel(state);
  const frames: PeonSocketFrame[] = [];
  const transport = sender(frames);
  const snapshot = state.snapshot();

  channel.negotiated(true, {
    capabilities: ["durable-delivery-v1", "daemon-configuration-v1"],
    channels: { "daemon-configuration-v1": {
      epoch: snapshot.epoch, acknowledgedRevision: snapshot.revision, digest: snapshot.digest,
    } },
  }, transport);
  assert.equal(frames.length, 0);

  channel.negotiated(true, { channels: {} }, transport);
  assert.equal(frames.length, 1);
  const payload = (frames[0]!.frame as PeonSocketFrame);
  assert.equal(payload.type, "daemon_configuration_state");
  assert.deepEqual(Object.keys(payload.values as PeonSocketFrame).sort(),
    ["aiDefaultModel", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs", "name", "soul"]);
  assert.equal(JSON.stringify(payload).includes("overseerToken"), false);
  assert.equal((frames[0]!.options as PeonSocketFrame).capability, "daemon-configuration-v1");
});

test("configuration patch handler applies, noops, conflicts, and rejects forbidden fields", async () => {
  const original = settings.get();
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-config-command-"));
  const isolated = new SettingsService(new SettingsStore(path.join(root, "settings.json")));
  isolated.update(original);
  const state = new DaemonConfigurationState(path.join(root, "state.json"), Date.now, isolated);
  const channel = new DaemonConfigurationChannel(state, isolated);
  const handler = channel.commandHandler();
  const before = state.snapshot();
  const base = {
    commandId: randomUUID(),
    operation: "daemon.configuration.patch",
    target: { peonId: randomUUID() },
    actor: { userId: randomUUID(), email: "operator@example.com" },
    expected: { epoch: before.epoch, revision: before.revision, digest: before.digest },
    requestedAt: Date.now(),
  };
  assert.match(handler.validate({ patch: { name: "unnegotiated" } }, base.expected)!, /negotiated/);
  channel.negotiated(true, { channels: {} }, sender([]));
  assert.match(handler.validate({ patch: { overseerToken: "secret" } }, base.expected)!, /forbidden/);

  const desired = before.values.name === "OVSR-86" ? "OVSR-86-b" : "OVSR-86";
  const applied = await handler.execute({ ...base, payload: { patch: { name: desired } } });
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.equal(state.snapshot().values.name, desired);
  assert.equal(state.snapshot().revision, before.revision + 1);

  const noop = await handler.execute({ ...base, commandId: randomUUID(), payload: { patch: { name: desired } } });
  assert.equal(noop.status, "noop");
  const conflict = await handler.execute({ ...base, commandId: randomUUID(), payload: { patch: { name: `${desired}-other` } } });
  assert.equal(conflict.status, "conflict");
  assert.equal(state.snapshot().values.name, desired);

  const current = state.snapshot();
  const rejected = await handler.execute({
    ...base,
    commandId: randomUUID(),
    expected: { epoch: current.epoch, revision: current.revision, digest: current.digest },
    payload: { patch: { heartbeatIntervalMs: 1 } },
  });
  assert.deepEqual(rejected, {
    status: "rejected",
    code: "INVALID_VALUE",
    result: { errors: [{ code: "INVALID_VALUE", message: "configuration patch rejected" }] },
  });
});
