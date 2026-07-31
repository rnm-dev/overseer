import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import WebSocket from "ws";
import { bindPeon, mintCredential } from "./credentials.js";
import { initDb, query } from "./db.js";
import {
  createOrGetReverseCommand,
  DEFAULT_REVERSE_COMMAND_LIMITS,
  REVERSE_COMMAND_OPERATIONS,
  ReverseCommandGateway,
  assertSafeReverseCommandResult,
  getReverseCommand,
  hasActiveUpdateCommand,
  reverseCommandHttpResult,
  reverseCommandGateway,
  type ReverseCommandHttpResult,
  type ReverseCommandResultFrame,
} from "./modules/reverseCommands/index.js";
import { getPeonConnection } from "./peonConnections.js";
import { attachPeonSocket } from "./peonSocket.js";
import { registry } from "./registry.js";

const ownerId = "b169219d-45f6-4f42-b78f-3fb931dac7ee";
const owner = { userId: ownerId, email: "operator@example.com" };
const auth = {
  ...owner,
  githubLogin: null,
  avatarUrl: null,
  deviceId: "device-command-tests",
};
const sessionId = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";

function registryCommand(input: {
  workspaceId: string;
  peonId: string;
  commandId: string;
  requestHash: string;
}) {
  return {
    ...input,
    operation: "session.delete" as const,
    actor: owner,
    target: { peonId: input.peonId, sessionId },
    payload: {},
    expected: null,
    requestBytes: 256,
    requestedAt: Date.now(),
  };
}

function open(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function messages(ws: WebSocket) {
  const frames: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  ws.on("message", (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
    for (const waiter of waiters) waiter();
  });
  const waitFor = (
    predicate: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const inspect = () => {
      const found = frames.find(predicate);
      if (!found) return;
      clearTimeout(timer);
      waiters.delete(inspect);
      resolve(found);
    };
    const timer = setTimeout(() => {
      waiters.delete(inspect);
      reject(new Error(`timed out waiting for frame; received ${JSON.stringify(frames)}`));
    }, timeoutMs);
    waiters.add(inspect);
    inspect();
  });
  return { frames, waitFor };
}

interface Fixture {
  index: number;
  workspaceId: string;
  peonId: string;
  token: string;
  url: string;
  server: http.Server;
  wss: ReturnType<typeof attachPeonSocket>;
  ws: WebSocket;
  received: ReturnType<typeof messages>;
  close(): Promise<void>;
}

async function fixture(
  index: number,
  operations = ["session.delete"],
  socketOptions: Parameters<typeof attachPeonSocket>[1] = {},
): Promise<Fixture> {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  const workspaceId = `command-workspace-${index}`;
  const peonId = `f4de920f-e33e-4cf5-97d0-3a75e92660${String(index).padStart(2, "0")}`;
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,$2,$3)`, [ownerId, owner.email, Date.now()]);
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,$2,$3,$4,$5)`,
    [workspaceId, `Commands ${index}`, workspaceId, ownerId, Date.now()],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ($1,$2,'owner',$3)`,
    [workspaceId, ownerId, Date.now()],
  );
  const { credential, token } = await mintCredential(workspaceId, "Command Peon", ownerId);
  await bindPeon(credential.id, peonId);
  await registry.register({
    peonId,
    credentialId: credential.id,
    workspaceId,
    name: "Command Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 4570,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });
  await query(
    `INSERT INTO sessions (peon_id,session_id,status,raw,synced_at)
     VALUES ($1,$2,'running',$3,$4)`,
    [peonId, sessionId, JSON.stringify({ id: sessionId, deleted: true }), Date.now()],
  );
  const server = http.createServer();
  const wss = attachPeonSocket(server, socketOptions);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const url = `ws://127.0.0.1:${port}/api/v1/peons/ws`;
  const ws = await open(url, token);
  const received = messages(ws);
  ws.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId,
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "reverse-command-v1"],
    channels: {
      "session-catalog-v1": {
        epoch: `catalog-${index}`,
        revision: 0,
        earliestSeq: 0,
        latestSeq: 0,
      },
      "reverse-command-v1": { protocol: 1, operations },
    },
    delivery: {
      epoch: `delivery-${index}`,
      earliestCursor: null,
      latestCursor: null,
      acknowledgedCursor: null,
      pendingMessages: 0,
      pendingBytes: 0,
      maxMessages: 10_000,
      maxBytes: 33_554_432,
      backpressured: false,
      negotiated: false,
      recoveredFromCorruption: false,
      lastError: null,
    },
  }));
  const ack = await received.waitFor((frame) => frame.type === "hello_ack");
  assert.equal(
    (ack.capabilities as unknown[]).includes("reverse-command-v1"),
    operations.some((operation) => (REVERSE_COMMAND_OPERATIONS as readonly string[]).includes(operation)),
  );
  const snapshot = await received.waitFor((frame) => frame.type === "session_catalog_snapshot_request");
  ws.send(JSON.stringify({
    type: "session_catalog_snapshot_page",
    requestId: snapshot.requestId,
    epoch: `catalog-${index}`,
    revision: 0,
    barrierSeq: 0,
    sessions: [{ id: sessionId, deleted: true }],
    nextCursor: null,
    hasMore: false,
  }));
  await received.waitFor((frame) => frame.type === "session_catalog_ack");

  return {
    index,
    workspaceId,
    peonId,
    token,
    url,
    server,
    wss,
    ws,
    received,
    async close() {
      ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function reconnect(
  f: Fixture,
  acknowledgedCursor: string | null = null,
): Promise<{ ws: WebSocket; received: ReturnType<typeof messages> }> {
  const ws = await open(f.url, f.token);
  const received = messages(ws);
  ws.send(JSON.stringify({
    type: "hello",
    protocol: 1,
    peonId: f.peonId,
    capabilities: ["session-catalog-v1", "durable-delivery-v1", "reverse-command-v1"],
    channels: {
      "session-catalog-v1": {
        epoch: `catalog-${f.index}`,
        revision: 0,
        earliestSeq: 0,
        latestSeq: 0,
      },
      "reverse-command-v1": {
        protocol: 1,
        operations: ["session.delete"],
      },
    },
    delivery: {
      epoch: `delivery-${f.index}`,
      earliestCursor: null,
      latestCursor: null,
      acknowledgedCursor,
      pendingMessages: 0,
      pendingBytes: 0,
      maxMessages: 10_000,
      maxBytes: 33_554_432,
      backpressured: false,
      negotiated: true,
      recoveredFromCorruption: false,
      lastError: null,
    },
  }));
  await received.waitFor((frame) => frame.type === "hello_ack");
  const snapshot = received.frames.find((frame) => frame.type === "session_catalog_snapshot_request");
  if (snapshot) {
    ws.send(JSON.stringify({
      type: "session_catalog_snapshot_page",
      requestId: snapshot.requestId,
      epoch: `catalog-${f.index}`,
      revision: 0,
      barrierSeq: 0,
      sessions: [],
      nextCursor: null,
      hasMore: false,
    }));
    await received.waitFor((frame) => frame.type === "session_catalog_ack");
  }
  return { ws, received };
}

test("gateway derives the actor, deduplicates browser retries, and commits a durable result before ACK", async () => {
  const f = await fixture(1);
  const commandId = "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  try {
    const first = reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth: { ...auth, email: "forged@example.com" },
      operation: "session.delete",
      target: { sessionId },
      payload: {},
      expected: null,
      commandId,
      waitMs: 2_000,
    });
    const second = reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 2_000,
    });
    const command = await f.received.waitFor((frame) => frame.type === "command");
    assert.deepEqual(command.actor, owner);
    assert.equal(command.commandId, commandId);
    assert.equal(f.received.frames.filter((frame) => frame.type === "command").length, 1);

    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: false,
      acceptedAt: Date.now(),
    }));
    f.ws.send(JSON.stringify({
      type: "durable_message",
      epoch: "delivery-1",
      cursor: "0000000000000001",
      messageId: "b47f43a9-a537-4af7-abcf-ad7acfef8904",
      priority: "critical",
      capability: "reverse-command-v1",
      payload: {
        type: "command_result",
        protocol: 1,
        commandId,
        operation: "session.delete",
        status: "applied",
        code: "OK",
        completedAt: Date.now(),
        result: { sessionId, deleted: true },
      },
    }));
    await f.received.waitFor((frame) => frame.type === "durable_ack" && frame.cursor === "0000000000000001");
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    assert.equal((await getReverseCommand(f.workspaceId, f.peonId, commandId))?.durableCommittedAt !== null, true);
    assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM reverse_command_audit`)).rows[0]?.count, 1);
    assert.equal((await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM events
        WHERE workspace_id=$1 AND peon_id=$2 AND kind='command' AND payload->>'commandId'=$3`,
      [f.workspaceId, f.peonId, commandId],
    )).rows[0]?.count, 1);
    assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox`)).rows[0]?.count, 1);

    // The same durable message is an idempotent replay: ACK again, no second
    // audit/browser event.
    f.ws.send(JSON.stringify({
      type: "durable_message",
      epoch: "delivery-1",
      cursor: "0000000000000001",
      messageId: "b47f43a9-a537-4af7-abcf-ad7acfef8904",
      priority: "critical",
      capability: "reverse-command-v1",
      payload: (f.received.frames.find((frame) => frame.type === "command") && {
        type: "command_result",
        protocol: 1,
        commandId,
        operation: "session.delete",
        status: "applied",
        code: "OK",
        completedAt: (await getReverseCommand(f.workspaceId, f.peonId, commandId))!.completedAt,
        result: { sessionId, deleted: true },
      }),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM events
        WHERE workspace_id=$1 AND peon_id=$2 AND kind='command' AND payload->>'commandId'=$3`,
      [f.workspaceId, f.peonId, commandId],
    )).rows[0]?.count, 1);
  } finally {
    await f.close();
  }
});

test("update results accept only operation-specific safe terminal tuples", () => {
  const sha256 = "a".repeat(64);
  const revision = "release-revision-1";
  const record = {
    operation: "update.apply",
    target: { peonId: "f4de920f-e33e-4cf5-97d0-3a75e9266090" },
  } as const;
  const base = {
    type: "command_result",
    protocol: 1,
    commandId: "018f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
    operation: "update.apply",
    completedAt: Date.now(),
  } as const;

  assert.doesNotThrow(() => assertSafeReverseCommandResult(record, {
    ...base,
    status: "applied",
    code: "OK",
    result: { version: "0.11.3", revision, sha256, attested: true },
  }));
  const invalidResults: Array<Pick<ReverseCommandResultFrame, "status" | "code" | "result">> = [
    { status: "applied", code: "ATTESTATION_MISMATCH", result: { version: "0.11.3", revision, sha256, attested: true } },
    { status: "failed", code: "OK", result: null },
    { status: "applied", code: "OK", result: { version: "0.11.3", revision, sha256, attested: false } },
    { status: "failed", code: "UPDATE_FAILED", result: { secret: "credential" } },
  ];
  for (const result of invalidResults) {
    assert.throws(() => assertSafeReverseCommandResult(record, { ...base, ...result }));
  }
});

test("a Peon admits only one concurrent update operation", async () => {
  const f = await fixture(21, ["update.check", "update.apply"]);
  try {
    const first = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      commandId: "218f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "update.apply",
      target: {},
      payload: { release: { version: "0.11.3", revision: "release-revision-1", sha256: "a".repeat(64) } },
      waitMs: 0,
    });
    assert.equal(first.status, 202);
    assert.equal(await hasActiveUpdateCommand(f.peonId), true);
    const second = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      commandId: "228f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "update.check",
      target: {},
      payload: {},
      waitMs: 0,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "UPDATE_IN_PROGRESS");
    assert.equal(
      (await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM reverse_commands
          WHERE workspace_id=$1 AND peon_id=$2 AND operation LIKE 'update.%'`,
        [f.workspaceId, f.peonId],
      )).rows[0]?.count,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Armory configuration secrets are sent once but never persisted", async () => {
  const f = await fixture(21, ["armory.configure"]);
  const commandId = "218f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  const secret = "armory_secret_must_remain_transient";
  try {
    const response = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "armory.configure",
      target: { packageId: "safe-package" },
      payload: { values: { API_TOKEN: secret }, confirmHostWrites: true },
      commandId,
      waitMs: 0,
    });
    assert.equal(response.status, 202);
    const command = await f.received.waitFor((frame) => frame.type === "command"
      && frame.commandId === commandId);
    assert.equal((command.payload as { values: { API_TOKEN: string } }).values.API_TOKEN, secret);

    const persisted = await getReverseCommand(f.workspaceId, f.peonId, commandId);
    assert.deepEqual(persisted?.payload, {});
    assert.doesNotMatch(JSON.stringify(persisted), new RegExp(secret));
    const raw = await query<{ payload: string; target: string }>(
      `SELECT payload::text AS payload, target::text AS target
         FROM reverse_commands
        WHERE workspace_id=$1 AND peon_id=$2 AND command_id=$3`,
      [f.workspaceId, f.peonId, commandId],
    );
    assert.doesNotMatch(JSON.stringify(raw.rows[0]), new RegExp(secret));
  } finally {
    await f.close();
  }
});

test("ACL/capability failures and forged actors are exclusive and never create or send a command", async () => {
  const f = await fixture(2, []);
  const gateway = new ReverseCommandGateway();
  try {
    const result = await gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId: "128f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      waitMs: 0,
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(f.received.frames.some((frame) => frame.type === "command"), false);
    assert.equal((await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM reverse_commands`)).rows[0]?.count, 0);

    const spoofed = await gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      actor: { userId: ownerId, email: "attacker@example.com" },
      operation: "session.delete",
      target: { sessionId },
      commandId: "228f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      waitMs: 0,
    } as never);
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.code, "BAD_COMMAND");
  } finally {
    await f.close();
  }
});

test("pre-admission command refusals terminate only their command and preserve the socket", async () => {
  const f = await fixture(30, ["session.delete"]);
  const firstId = "308f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  const secondId = "318f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  try {
    const first = reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId: firstId,
      waitMs: 2_000,
    });
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === firstId);
    f.ws.send(JSON.stringify({
      type: "command_result",
      protocol: 1,
      commandId: firstId,
      operation: "session.delete",
      status: "rejected",
      code: "BAD_COMMAND",
      completedAt: Date.now(),
      result: null,
    }));
    const refused = await first;
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "BAD_COMMAND");
    assert.equal(f.ws.readyState, WebSocket.OPEN);
    const record = await getReverseCommand(f.workspaceId, f.peonId, firstId);
    assert.equal(record?.state, "terminal");
    assert.ok(record?.durableCommittedAt);
    assert.equal(record?.attemptCount, 1);

    const second = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId: secondId,
      waitMs: 0,
    });
    assert.equal(second.status, 202);
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === secondId);
    assert.equal(f.ws.readyState, WebSocket.OPEN);
  } finally {
    await f.close();
  }
});

test("gateway rejects non-object payloads before admission", async () => {
  const f = await fixture(14);
  try {
    for (const [offset, payload] of [[0, []], [1, null]] as const) {
      const result = await reverseCommandGateway.submit({
        workspaceId: f.workspaceId,
        peonId: f.peonId,
        auth,
        operation: "session.delete",
        target: { sessionId },
        payload,
        commandId: `${offset + 1}48f4f0c-9f30-7a61-bf1a-66d2582bdb4a`,
        waitMs: 0,
      } as never);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "BAD_COMMAND");
    }
    assert.equal(f.received.frames.some((frame) => frame.type === "command"), false);
    assert.equal((await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reverse_commands`,
    )).rows[0]?.count, 0);
  } finally {
    await f.close();
  }
});

test("hello intersects supported operations instead of rejecting a newer Peon", async () => {
  const f = await fixture(15, ["session.delete", "project.archive", "project.unarchive"]);
  try {
    const result = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId: "358f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      waitMs: 0,
    });
    assert.equal(result.status, 202);
    await f.received.waitFor(
      (frame) => frame.type === "command" && frame.operation === "session.delete",
    );
  } finally {
    await f.close();
  }
});


test("unsafe operation tuples cannot persist, publish, return 200, or regress projection", async () => {
  const f = await fixture(5);
  const commandId = "628f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  try {
    const submitted = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 0,
    });
    assert.equal(submitted.status, 202);
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);
    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: false,
      acceptedAt: Date.now(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const disconnected = new Promise<void>((resolve) => f.ws.once("close", () => resolve()));
    f.ws.send(JSON.stringify({
      type: "command_status",
      protocol: 1,
      commandId,
      state: "terminal",
      result: {
        type: "command_result",
        protocol: 1,
        commandId,
        operation: "session.delete",
        status: "applied",
        code: "UNKNOWN_SESSION",
        completedAt: Date.now(),
        result: {
          sessionId,
          deleted: true,
        },
      },
    }));
    await disconnected;
    const stored = await getReverseCommand(f.workspaceId, f.peonId, commandId);
    assert.equal(stored?.state, "accepted");
    assert.equal(stored?.result, null);
    assert.equal((await query<{ status: string | null }>(
      `SELECT status FROM sessions WHERE peon_id=$1 AND session_id=$2`,
      [f.peonId, sessionId],
    )).rows[0]?.status, null);
    assert.equal((await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM events WHERE kind='command'`,
    )).rows[0]?.count, 0);

    assert.ok(stored);
    const contradictory: ReverseCommandResultFrame = {
      type: "command_result",
      protocol: 1,
      commandId,
      operation: "session.delete",
      status: "applied",
      code: "UNKNOWN_SESSION",
      completedAt: Date.now(),
      result: { sessionId, deleted: true },
    };
    assert.equal(reverseCommandHttpResult({
      ...stored,
      state: "terminal",
      terminalStatus: "applied",
      code: "UNKNOWN_SESSION",
      result: contradictory.result,
      resultFrame: contradictory,
    }).status, 502);

    const safeRejected: ReverseCommandResultFrame = {
      type: "command_result",
      protocol: 1,
      commandId,
      operation: "session.delete",
      status: "rejected",
      code: "UNKNOWN_SESSION",
      completedAt: Date.now(),
      result: null,
    };
    const mismatched = reverseCommandHttpResult({
      ...stored,
      state: "terminal",
      completedAt: safeRejected.completedAt,
      terminalStatus: "applied",
      code: "OK",
      result: { sessionId, deleted: true },
      resultFrame: safeRejected,
    });
    assert.equal(mismatched.status, 502);
    assert.equal(mismatched.body.code, "UNSAFE_RESULT");
    assert.equal(mismatched.body.status, null);
    assert.equal(mismatched.body.result, null);
  } finally {
    await f.close();
  }
});

test("command IDs are Peon-scoped and per-user pending limits span workspaces", async () => {
  const f = await fixture(6);
  try {
    const sameId = "728f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
    const secondPeon = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const first = await createOrGetReverseCommand(registryCommand({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      commandId: sameId,
      requestHash: "a".repeat(64),
    }));
    const second = await createOrGetReverseCommand(registryCommand({
      workspaceId: f.workspaceId,
      peonId: secondPeon,
      commandId: sameId,
      requestHash: "b".repeat(64),
    }));
    assert.equal(first.kind, "created");
    assert.equal(second.kind, "created");
    assert.equal((await getReverseCommand(f.workspaceId, f.peonId, sameId))?.requestHash, "a".repeat(64));
    assert.equal((await getReverseCommand(f.workspaceId, secondPeon, sameId))?.requestHash, "b".repeat(64));
    const statusGateway = new ReverseCommandGateway();
    assert.equal(
      (await statusGateway.status(f.workspaceId, f.peonId, sameId, ownerId))?.record?.requestHash,
      "a".repeat(64),
    );
    assert.equal(
      (await statusGateway.status(f.workspaceId, secondPeon, sameId, ownerId))?.record?.requestHash,
      "b".repeat(64),
    );
    assert.equal(
      await statusGateway.status(
        f.workspaceId,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sameId,
        ownerId,
      ),
      null,
    );

    const limits = {
      ...DEFAULT_REVERSE_COMMAND_LIMITS,
      userPending: 1,
      globalPending: 100,
      workspacePending: 100,
      peonPending: 100,
    };
    await query(`DELETE FROM reverse_commands`);
    const globalUserFirst = await createOrGetReverseCommand(registryCommand({
      workspaceId: "workspace-global-user-a",
      peonId: f.peonId,
      commandId: "828f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      requestHash: "c".repeat(64),
    }), limits);
    const globalUserSecond = await createOrGetReverseCommand(registryCommand({
      workspaceId: "workspace-global-user-b",
      peonId: secondPeon,
      commandId: "928f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      requestHash: "d".repeat(64),
    }), limits);
    assert.equal(globalUserFirst.kind, "created");
    assert.deepEqual(globalUserSecond, { kind: "overloaded", scope: "user" });
  } finally {
    await f.close();
  }
});

test("a socket replaced after durable admission fencing never receives the command", async () => {
  const f = await fixture(7);
  const commandId = "a28f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  let enteredSend!: () => void;
  let releaseSend!: () => void;
  const sendEntered = new Promise<void>((resolve) => { enteredSend = resolve; });
  const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
  const gateway = new ReverseCommandGateway({
    beforeSocketSend: async () => {
      enteredSend();
      await sendReleased;
    },
  });
  let replacement: WebSocket | null = null;
  try {
    const submitting = gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 0,
    });
    await sendEntered;
    const next = await reconnect(f);
    replacement = next.ws;
    const replay = await next.received.waitFor(
      (frame) => frame.type === "command" && frame.commandId === commandId,
    );
    assert.equal(replay.commandId, commandId);
    releaseSend();
    assert.equal((await submitting).status, 202);
    assert.equal(
      f.received.frames.some((frame) => frame.type === "command" && frame.commandId === commandId),
      false,
    );
  } finally {
    releaseSend?.();
    replacement?.close();
    await f.close();
  }
});

test("a stale connectionReady cannot rebind over the replacement generation", async () => {
  const f = await fixture(8);
  const commandId = "b28f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  let enteredReady!: () => void;
  let releaseReady!: () => void;
  const readyEntered = new Promise<void>((resolve) => { enteredReady = resolve; });
  const readyReleased = new Promise<void>((resolve) => { releaseReady = resolve; });
  const staleGateway = new ReverseCommandGateway({
    afterConnectionOwnershipCheck: async () => {
      enteredReady();
      await readyReleased;
    },
  });
  let replacement: WebSocket | null = null;
  try {
    const submitted = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 0,
    });
    assert.equal(submitted.status, 202);
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);
    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: false,
      acceptedAt: Date.now(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const serverSocket = getPeonConnection(f.peonId);
    assert.ok(serverSocket);
    const staleReady = staleGateway.connectionReady(f.workspaceId, f.peonId, serverSocket);
    await readyEntered;
    const next = await reconnect(f);
    replacement = next.ws;
    const status = await next.received.waitFor(
      (frame) => frame.type === "command_status_request" && frame.commandId === commandId,
    );
    assert.equal(status.commandId, commandId);
    releaseReady();
    await staleReady;
    assert.equal(
      f.received.frames.some((frame) => frame.type === "command_status_request"),
      false,
    );
  } finally {
    releaseReady?.();
    replacement?.close();
    await f.close();
  }
});

test("submit during canonical hello remains unavailable and creates no stranded row", async () => {
  const index = 9;
  const workspaceId = `command-workspace-${index}`;
  const peonId = `f4de920f-e33e-4cf5-97d0-3a75e92660${String(index).padStart(2, "0")}`;
  const commandId = "c28f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  let duringStart: ReverseCommandHttpResult | null = null;
  const f = await fixture(index, ["session.delete"], {
    beforeCanonicalHelloAck: async () => {
      duringStart = await reverseCommandGateway.submit({
        workspaceId,
        peonId,
        auth,
        operation: "session.delete",
        target: { sessionId },
        commandId,
        waitMs: 0,
      });
    },
  });
  try {
    const observed = duringStart as ReverseCommandHttpResult | null;
    assert.ok(observed);
    assert.equal(observed.status, 503);
    assert.equal(observed.body.code, "CAPABILITY_UNAVAILABLE");
    assert.equal((await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reverse_commands WHERE command_id=$1`,
      [commandId],
    )).rows[0]?.count, 0);
    assert.equal(f.received.frames.some((frame) => frame.type === "command"), false);
  } finally {
    await f.close();
  }
});

test("accepted row replacement exposes ownership only after hello_ack and reconciles once", async () => {
  const index = 10;
  const commandId = "d28f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  let helloStarts = 0;
  let replacementSubmit: ReverseCommandHttpResult | null = null;
  const f = await fixture(index, ["session.delete"], {
    beforeCanonicalHelloAck: async () => {
      helloStarts += 1;
      if (helloStarts !== 2) return;
      replacementSubmit = await reverseCommandGateway.submit({
        workspaceId: `command-workspace-${index}`,
        peonId: `f4de920f-e33e-4cf5-97d0-3a75e92660${String(index).padStart(2, "0")}`,
        auth,
        operation: "session.delete",
        target: { sessionId },
        commandId,
        waitMs: 0,
      });
    },
  });
  let replacement: WebSocket | null = null;
  try {
    const submitted = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 0,
    });
    assert.equal(submitted.status, 202);
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);
    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: false,
      acceptedAt: Date.now(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const next = await reconnect(f);
    replacement = next.ws;
    const observed = replacementSubmit as ReverseCommandHttpResult | null;
    assert.ok(observed);
    assert.equal(observed.status, 503);
    assert.equal(observed.body.code, "CAPABILITY_UNAVAILABLE");
    const status = await next.received.waitFor(
      (frame) => frame.type === "command_status_request" && frame.commandId === commandId,
    );
    assert.equal(status.commandId, commandId);
    const ackIndex = next.received.frames.findIndex((frame) => frame.type === "hello_ack");
    const statusIndex = next.received.frames.findIndex(
      (frame) => frame.type === "command_status_request" && frame.commandId === commandId,
    );
    assert.ok(ackIndex >= 0 && statusIndex > ackIndex);
    assert.equal(next.received.frames.filter(
      (frame) => frame.type === "command_status_request" && frame.commandId === commandId,
    ).length, 1);
    assert.equal((await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reverse_commands WHERE command_id=$1`,
      [commandId],
    )).rows[0]?.count, 1);
    assert.equal((await getReverseCommand(f.workspaceId, f.peonId, commandId))?.state, "accepted");
  } finally {
    replacement?.close();
    await f.close();
  }
});

test("an HTTP wait cannot miss a terminal commit before its waiter observes the row", async () => {
  const f = await fixture(16);
  const commandId = "e28f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  let waiterEntered!: () => void;
  let releaseWaiter!: () => void;
  const entered = new Promise<void>((resolve) => { waiterEntered = resolve; });
  const released = new Promise<void>((resolve) => { releaseWaiter = resolve; });
  const gateway = new ReverseCommandGateway({
    afterWaiterRegistered: async () => {
      waiterEntered();
      await released;
    },
  });
  try {
    const submitting = gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 2_000,
    });
    await entered;
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);
    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: false,
      acceptedAt: Date.now(),
    }));
    f.ws.send(JSON.stringify({
      type: "durable_message",
      epoch: "delivery-16",
      cursor: "0000000000000001",
      messageId: "e47f43a9-a537-4af7-abcf-ad7acfef8904",
      priority: "critical",
      capability: "reverse-command-v1",
      payload: {
        type: "command_result",
        protocol: 1,
        commandId,
        operation: "session.delete",
        status: "applied",
        code: "OK",
        completedAt: Date.now(),
        result: { sessionId, deleted: true },
      },
    }));
    await f.received.waitFor(
      (frame) => frame.type === "durable_ack" && frame.cursor === "0000000000000001",
    );
    releaseWaiter();
    const prompt = await Promise.race([
      submitting,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 750)),
    ]);
    assert.ok(prompt);
    assert.equal(prompt.status, 200);
  } finally {
    releaseWaiter?.();
    await f.close();
  }
});

test("an expired HTTP wait asks Peon status with the same command ID", async () => {
  const f = await fixture(17);
  const commandId = "f28f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  try {
    const submitted = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 0,
    });
    assert.equal(submitted.status, 202);
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);
    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: false,
      acceptedAt: Date.now(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const retry = await reverseCommandGateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 25,
    });
    assert.equal(retry.status, 202);
    assert.equal(retry.body.code, "COMMAND_PENDING");
    const status = await f.received.waitFor(
      (frame) => frame.type === "command_status_request" && frame.commandId === commandId,
    );
    assert.equal(status.commandId, commandId);
  } finally {
    await f.close();
  }
});

test("pending limits are enforced before a second command is queued", async () => {
  const f = await fixture(3);
  const gateway = new ReverseCommandGateway({
    limits: {
      globalPending: 1,
      workspacePending: 1,
      peonPending: 1,
      userPending: 1,
    },
  });
  try {
    const first = await gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId: "318f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      waitMs: 0,
    });
    assert.equal(first.status, 202);
    const second = await gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId: "418f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      waitMs: 0,
    });
    assert.equal(second.status, 429);
    assert.equal(second.body.code, "COMMAND_PENDING_LIMIT");
    assert.equal(f.received.frames.filter((frame) => frame.type === "command").length, 1);
  } finally {
    await f.close();
  }
});

test("disconnect boundaries and a fresh gateway reconcile with the same command ID", async () => {
  const commandId = "518f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  let releaseTerminalObserved!: () => void;
  const terminalObserved = new Promise<void>((resolve) => { releaseTerminalObserved = resolve; });
  const gateway = new ReverseCommandGateway({
    afterTerminalObserved: async (record) => {
      if (record.commandId === commandId) releaseTerminalObserved();
    },
  });
  const f = await fixture(4, ["session.delete"], { commandGateway: gateway });
  let current = f.ws;
  try {
    const pending = await gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 0,
    });
    assert.equal(pending.status, 202);
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);

    // No acceptance was observed: reconnect retries the exact persisted frame,
    // never a new command ID.
    const closed = new Promise<void>((resolve) => current.once("close", () => resolve()));
    current.close();
    await closed;
    const second = await reconnect(f);
    current = second.ws;
    const replay = await second.received.waitFor((frame) => frame.type === "command");
    assert.equal(replay.commandId, commandId);
    second.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId,
      operation: "session.delete",
      state: "accepted",
      replayed: true,
      acceptedAt: Date.now(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // After durable admission, reconnect asks status; it must not create or
    // resend a different logical command.
    const secondClosed = new Promise<void>((resolve) => second.ws.once("close", () => resolve()));
    second.ws.close();
    await secondClosed;
    const third = await reconnect(f);
    current = third.ws;
    const status = await third.received.waitFor((frame) => frame.type === "command_status_request");
    assert.equal(status.commandId, commandId);
    assert.equal(third.received.frames.some((frame) => frame.type === "command"), false);

    // A terminal status is useful for the waiting API call but not durable.
    // If the socket changes before the result is replayed, the new generation
    // must still be allowed to commit the exact terminal frame.
    const completedAt = Date.now();
    const terminalResult = {
      type: "command_result",
      protocol: 1,
      commandId,
      operation: "session.delete",
      status: "applied",
      code: "OK",
      completedAt,
      result: { sessionId, deleted: true },
    };
    third.ws.send(JSON.stringify({
      type: "command_status",
      protocol: 1,
      commandId,
      state: "terminal",
      result: terminalResult,
    }));
    await terminalObserved;
    assert.equal((await getReverseCommand(f.workspaceId, f.peonId, commandId))?.state, "terminal");
    await query(
      `UPDATE reverse_commands SET updated_at=$4
        WHERE workspace_id=$1 AND peon_id=$2 AND command_id=$3`,
      [f.workspaceId, f.peonId, commandId, Date.now() - 30 * 24 * 60 * 60 * 1_000],
    );

    const thirdClosed = new Promise<void>((resolve) => third.ws.once("close", () => resolve()));
    third.ws.close();
    await thirdClosed;
    const fourth = await reconnect(f);
    current = fourth.ws;
    fourth.ws.send(JSON.stringify({
      type: "durable_message",
      epoch: "delivery-4",
      cursor: "0000000000000001",
      messageId: "0d43239b-b4a1-485c-8b36-b8e9ad952641",
      priority: "critical",
      capability: "reverse-command-v1",
      payload: terminalResult,
    }));
    await fourth.received.waitFor(
      (frame) => frame.type === "durable_ack" && frame.cursor === "0000000000000001",
    );
    assert.equal((await getReverseCommand(f.workspaceId, f.peonId, commandId))?.durableCommittedAt !== null, true);
    assert.equal(
      (await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM events
          WHERE workspace_id=$1 AND peon_id=$2 AND kind='command' AND payload->>'commandId'=$3`,
        [f.workspaceId, f.peonId, commandId],
      )).rows[0]?.count,
      1,
    );

    // A process-local gateway can be rebuilt from the database and performs
    // the same status reconciliation without any in-memory pending registry.
    const restartedGateway = new ReverseCommandGateway();
    const rebuilt = await restartedGateway.status(f.workspaceId, f.peonId, commandId, ownerId);
    assert.equal(rebuilt?.record?.state, "terminal");
    assert.equal(rebuilt?.record?.commandId, commandId);
  } finally {
    if (current !== f.ws) current.close();
    await f.close();
  }
});

test("disconnect before acceptance wakes an HTTP wait as pending, not a false timeout", async () => {
  const commandId = "558f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  const gateway = new ReverseCommandGateway();
  const f = await fixture(30, ["session.delete"], { commandGateway: gateway });
  try {
    const submitting = gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 5_000,
    });
    await f.received.waitFor((frame) => frame.type === "command" && frame.commandId === commandId);
    f.ws.close();

    const result = await submitting;
    assert.equal(result.status, 202);
    assert.equal(result.body.code, "COMMAND_PENDING");
    assert.equal(result.record?.state, "sent");
    assert.equal(result.record?.lastErrorCode, "CONNECTION_LOST");
  } finally {
    await f.close();
  }
});

test("an actually expired wait still returns COMMAND_TIMEOUT", async () => {
  const commandId = "608f4f0c-9f30-7a61-bf1a-66d2582bdb4a";
  const gateway = new ReverseCommandGateway();
  const f = await fixture(32, ["session.delete"], { commandGateway: gateway });
  try {
    const result = await gateway.submit({
      workspaceId: f.workspaceId,
      peonId: f.peonId,
      auth,
      operation: "session.delete",
      target: { sessionId },
      commandId,
      waitMs: 25,
    });

    assert.equal(result.status, 504);
    assert.equal(result.body.code, "COMMAND_TIMEOUT");
  } finally {
    await f.close();
  }
});

test("a stale correlated frame is ignored without closing the current control socket", async () => {
  const f = await fixture(31);
  try {
    f.ws.send(JSON.stringify({
      type: "command_accepted",
      protocol: 1,
      commandId: "658f4f0c-9f30-7a61-bf1a-66d2582bdb4a",
      operation: "session.delete",
      state: "accepted",
      replayed: true,
      acceptedAt: Date.now(),
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(f.ws.readyState, WebSocket.OPEN);
  } finally {
    await f.close();
  }
});
