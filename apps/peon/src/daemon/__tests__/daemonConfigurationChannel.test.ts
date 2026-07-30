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

function isolatedConfiguration(root: string): SettingsService {
  const service = new SettingsService(new SettingsStore(path.join(root, "settings.json")));
  service.update(settings.get());
  return service;
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

test("daemon configuration publishes old and mismatched checkpoints but rejects a future revision", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-config-replay-"));
  const configuration = isolatedConfiguration(root);
  const state = new DaemonConfigurationState(path.join(root, "state.json"), () => 456, configuration);
  const channel = new DaemonConfigurationChannel(state, configuration);
  const frames: PeonSocketFrame[] = [];
  const disconnects: string[] = [];
  const transport = {
    ...sender(frames),
    disconnect: (reason: string) => { disconnects.push(reason); },
  };
  const snapshot = state.snapshot();

  channel.negotiated(true, { channels: { "daemon-configuration-v1": {
    epoch: snapshot.epoch, acknowledgedRevision: snapshot.revision - 1, digest: snapshot.digest,
  } } }, transport);
  channel.negotiated(true, { channels: { "daemon-configuration-v1": {
    epoch: randomUUID(), acknowledgedRevision: snapshot.revision, digest: snapshot.digest,
  } } }, transport);
  channel.negotiated(true, { channels: { "daemon-configuration-v1": {
    epoch: snapshot.epoch, acknowledgedRevision: snapshot.revision, digest: "0".repeat(64),
  } } }, transport);
  assert.equal(frames.length, 3);

  channel.negotiated(true, { channels: { "daemon-configuration-v1": {
    epoch: snapshot.epoch, acknowledgedRevision: snapshot.revision + 1, digest: snapshot.digest,
  } } }, transport);
  assert.deepEqual(disconnects, ["daemon configuration acknowledgement is from a future revision"]);
  assert.deepEqual(state.snapshot(), snapshot);
});

test("local safe changes share a monotonic restart-stable identity while private changes and noops do not", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-config-local-"));
  const configuration = isolatedConfiguration(root);
  const statePath = path.join(root, "state.json");
  const state = new DaemonConfigurationState(statePath, () => 100, configuration);
  const channel = new DaemonConfigurationChannel(state, configuration);
  const frames: PeonSocketFrame[] = [];
  channel.started(sender(frames));
  channel.negotiated(true, { channels: {} }, sender(frames));
  frames.length = 0;
  const before = state.snapshot();

  configuration.update({ paused: !configuration.get().paused });
  assert.equal(state.snapshot().revision, before.revision);
  assert.equal(frames.length, 0);

  configuration.update({ name: configuration.get().name });
  assert.equal(state.snapshot().revision, before.revision);
  assert.equal(frames.length, 0);

  const name = before.values.name === "local-change" ? "local-change-2" : "local-change";
  configuration.update({ name });
  const changed = state.snapshot();
  assert.equal(changed.revision, before.revision + 1);
  assert.equal((frames.at(-1)?.frame as PeonSocketFrame).reason, "local_change");
  assert.equal(JSON.stringify(frames.at(-1)).includes("overseerToken"), false);

  const restarted = new DaemonConfigurationState(statePath, () => 200, configuration).snapshot();
  assert.deepEqual(restarted, changed);
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

  for (const forbidden of ["overseerToken", "pairingSecret", "peonId", "overseerUrl", "bindHost", "paused"]) {
    assert.match(handler.validate({ patch: { [forbidden]: "secret" } }, base.expected)!, /forbidden/);
  }
  const invalidType = await handler.execute({
    ...base,
    commandId: randomUUID(),
    expected: current,
    payload: { patch: { name: { malicious: true } } },
  });
  assert.equal(invalidType.status, "rejected");
  const oversized = await handler.execute({
    ...base,
    commandId: randomUUID(),
    expected: current,
    payload: { patch: { soul: "x".repeat((48 * 1024) + 1) } },
  });
  assert.equal(oversized.status, "rejected");
  assert.equal(JSON.stringify(oversized).includes("x".repeat(128)), false);
});
