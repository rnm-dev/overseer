import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "./db.js";
import {
  commitDaemonConfigurationState,
  daemonConfigurationDigest,
  getDaemonConfigurationProjection,
  parseDurableDaemonConfigurationState,
  parseDaemonConfigurationHello,
} from "./modules/daemonConfiguration.js";
import { claimSessionSyncGeneration } from "./sessionIndex.js";
import { eventVisible, type AccessClient } from "./liveAccess.js";
import {
  assertSafeReverseCommandResult,
  type JsonObject,
  type ReverseCommandResultFrame,
  validateDaemonConfigurationPatch,
} from "./modules/reverseCommands/index.js";

const values = {
  name: "Nova",
  defaultAgent: "codex-app-server",
  fileTransferRoot: null,
  heartbeatIntervalMs: 15_000,
  aiDefaultModel: "gpt-5",
  aiDefaultReasoningEffort: null,
  soul: null,
};

async function database(): Promise<void> {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
}

function durable(cursor = "1", revision = 1) {
  const digest = daemonConfigurationDigest(values);
  return parseDurableDaemonConfigurationState({
    type: "durable_message",
    capability: "daemon-configuration-v1",
    epoch: "delivery-epoch",
    cursor,
    messageId: `00000000-0000-4000-8000-${cursor.padStart(12, "0")}`,
    priority: "control",
    payload: {
      type: "daemon_configuration_state",
      epoch: "configuration-epoch",
      revision,
      schemaVersion: 1,
      digest,
      updatedAt: 1_000 + revision,
      reason: "initial_sync",
      values,
    },
  });
}

test("daemon configuration parser accepts only the complete safe document and canonical digest", () => {
  const digest = daemonConfigurationDigest(values);
  assert.deepEqual(parseDaemonConfigurationHello({
    epoch: "configuration-epoch", revision: 1, schemaVersion: 1, digest,
  }), { epoch: "configuration-epoch", revision: 1, schemaVersion: 1, digest });
  assert.equal(durable().values.defaultAgent, "codex-app-server");
  assert.throws(() => parseDurableDaemonConfigurationState({
    type: "durable_message",
    capability: "daemon-configuration-v1", epoch: "delivery", cursor: "1",
    messageId: "00000000-0000-4000-8000-000000000001", priority: "control",
    payload: {
      type: "daemon_configuration_state", epoch: "config", revision: 1, schemaVersion: 1,
      digest, updatedAt: 1, reason: "initial_sync", values: { ...values, overseerToken: "secret" },
    },
  }), /unknown daemon configuration values field/);
  assert.throws(() => parseDurableDaemonConfigurationState({
    type: "durable_message",
    capability: "daemon-configuration-v1", epoch: "delivery", cursor: "1",
    messageId: "not-a-uuid", priority: "control",
    payload: {
      type: "daemon_configuration_state", epoch: "config", revision: 1, schemaVersion: 1,
      digest, updatedAt: 1, reason: "initial_sync", values,
    },
  }), /durable envelope/);
});

test("terminal configuration results enforce revision semantics and redact rejection detail", () => {
  const digest = daemonConfigurationDigest(values);
  const record = {
    operation: "daemon.configuration.patch" as const,
    target: { peonId: "00000000-0000-4000-8000-000000000001" },
  };
  const result = {
    type: "command_result" as const,
    protocol: 1 as const,
    commandId: "00000000-0000-4000-8000-000000000001",
    operation: "daemon.configuration.patch" as const,
    status: "applied" as const,
    code: "OK",
    completedAt: 2_000,
    result: {
      epoch: "configuration-epoch", previousRevision: 1, revision: 2, schemaVersion: 1,
      digest, updatedAt: 2_000, changedFields: ["name"],
      restart: { required: false, components: [] }, errors: [], values,
    },
  };
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, result));
  assert.throws(
    () => assertSafeReverseCommandResult(record, {
      ...result,
      result: { ...result.result, revision: 1 },
    }),
    /invalid daemon configuration result/,
  );
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, {
    ...result,
    status: "rejected",
    code: "INVALID_VALUE",
    result: { errors: [{ code: "INVALID_VALUE", message: "configuration patch rejected" }] },
  }));
  assert.throws(() => assertSafeReverseCommandResult(record, {
    ...result,
    status: "rejected",
    code: "INVALID_VALUE",
    result: { errors: [{ code: "INVALID_VALUE", message: "Bearer secret" }] },
  }), /unsafe daemon configuration error/);
});

test("state replay is idempotent after newer revisions and durable identity collisions fail closed", async () => {
  await database();
  await claimSessionSyncGeneration("peon-config", "generation-config");
  const input = {
    workspaceId: "workspace-config",
    peonId: "peon-config",
    syncGeneration: "generation-config",
    durable: durable(),
  };
  const first = await commitDaemonConfigurationState(input);
  const second = await commitDaemonConfigurationState({ ...input, durable: durable("2", 2) });
  const duplicate = await commitDaemonConfigurationState(input);
  await commitDaemonConfigurationState({ ...input, durable: durable("3", 2) });
  await commitDaemonConfigurationState({ ...input, durable: durable("4", 1) });
  assert.deepEqual(duplicate.delivery, second.delivery);
  assert.equal((await getDaemonConfigurationProjection("peon-config"))?.revision, 2);
  const counts = await query<{ inbox: string; events: string }>(
    `SELECT
      (SELECT COUNT(*) FROM peon_session_inbox WHERE peon_id='peon-config') AS inbox,
      (SELECT COUNT(*) FROM events WHERE peon_id='peon-config' AND kind='configuration') AS events`,
  );
  assert.deepEqual({ inbox: Number(counts.rows[0]?.inbox), events: Number(counts.rows[0]?.events) }, { inbox: 4, events: 2 });
  const collision = durable("5", 2);
  collision.digest = "0".repeat(64);
  await assert.rejects(
    commitDaemonConfigurationState({ ...input, durable: collision }),
    /revision digest collision/,
  );
  const cursorCollision = durable("2", 2);
  cursorCollision.messageId = "00000000-0000-4000-8000-000000000099";
  await assert.rejects(
    commitDaemonConfigurationState({ ...input, durable: cursorCollision }),
    /identity collision/,
  );
  const retiredEpoch = durable("6", 99);
  retiredEpoch.epoch = "retired-epoch";
  const covered = await commitDaemonConfigurationState({
    ...input,
    durable: retiredEpoch,
    advertisedIdentity: { epoch: "new-epoch", revision: 0, digest: retiredEpoch.digest },
  });
  assert.equal(covered.projected, false);
  assert.equal((await getDaemonConfigurationProjection("peon-config"))?.epoch, "configuration-epoch");
  const newEpoch = durable("7", 0);
  newEpoch.epoch = "new-epoch";
  const converged = await commitDaemonConfigurationState({
    ...input,
    durable: newEpoch,
    advertisedIdentity: { epoch: "new-epoch", revision: 0, digest: newEpoch.digest },
  });
  assert.equal(converged.projected, true);
  assert.equal((await getDaemonConfigurationProjection("peon-config"))?.epoch, "new-epoch");
  assert.deepEqual(first.projection.revision, 1);
});

test("configuration browser events are owner-only and contain no projected values", () => {
  const event = {
    cursor: 1,
    workspaceId: "workspace-config",
    peonId: "peon-config",
    sessionId: null,
    kind: "configuration" as const,
    payload: { operation: "daemon.configuration.state", peonId: "peon-config", revision: 2, updatedAt: 2_000 },
    createdAt: 2_000,
  };
  const client = (role: "owner" | "member"): AccessClient => ({
    userId: role,
    workspaceId: "workspace-config",
    role,
    allowedPeons: role === "owner" ? null : new Set(["peon-config"]),
    allowedProjects: role === "owner" ? null : new Map(),
    tails: new Map(),
  });
  assert.equal(eventVisible(client("owner"), event), true);
  assert.equal(eventVisible(client("member"), event), false);
  assert.equal(JSON.stringify(event).includes("fileTransferRoot"), false);
});

test("configuration terminal tuples validate digest and redact unsafe field errors", () => {
  const digest = daemonConfigurationDigest(values);
  const record = {
    operation: "daemon.configuration.patch" as const,
    target: { peonId: "00000000-0000-4000-8000-000000000001" },
  };
  const result: ReverseCommandResultFrame = {
    type: "command_result",
    protocol: 1,
    commandId: "00000000-0000-4000-8000-000000000002",
    operation: "daemon.configuration.patch",
    status: "applied",
    code: "OK",
    completedAt: 2_000,
    result: {
      epoch: "configuration-epoch",
      previousRevision: 1,
      revision: 2,
      schemaVersion: 1,
      digest,
      updatedAt: 2_000,
      changedFields: ["name"],
      restart: { required: false, components: [] },
      errors: [],
      values,
    } as JsonObject,
  };
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, result));
  assert.throws(() => assertSafeReverseCommandResult(record, {
    ...result,
    status: "rejected",
    code: "INVALID_VALUE",
    result: { errors: [{ code: "INVALID_VALUE", message: "overseerToken=secret" }] },
  }), /unsafe daemon configuration/);
  assert.throws(() => assertSafeReverseCommandResult(record, {
    ...result,
    result: { ...(result.result as JsonObject), digest: "0".repeat(64) },
  }), /digest mismatch/);
  assert.throws(() => assertSafeReverseCommandResult(record, {
    ...result,
    status: "conflict",
    code: "OK",
  }), /result identity/);
  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, {
    ...result,
    status: "failed",
    code: "INTERNAL",
    result: null,
  }));
});

test("configuration patch preflight rejects forbidden, oversized and invalid typed values before send", () => {
  assert.doesNotThrow(() => validateDaemonConfigurationPatch({
    name: null,
    defaultAgent: "codex-app-server",
    heartbeatIntervalMs: 15_000,
    aiDefaultModel: "gpt-5",
    aiDefaultReasoningEffort: "high",
  }));
  assert.throws(() => validateDaemonConfigurationPatch({ overseerToken: "secret" }), /unsupported fields/);
  assert.throws(() => validateDaemonConfigurationPatch({ heartbeatIntervalMs: 999 }), /invalid value/);
  assert.throws(() => validateDaemonConfigurationPatch({ aiDefaultReasoningEffort: 42 }), /invalid value/);
  assert.throws(() => validateDaemonConfigurationPatch({ soul: "x".repeat(48 * 1024 + 1) }), /invalid value/);
});
