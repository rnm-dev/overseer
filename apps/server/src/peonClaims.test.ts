import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { newDb } from "pg-mem";
import type pg from "pg";
import WebSocket from "ws";
import { issueDevice } from "./auth.js";
import { config } from "./config.js";
import { mintCredential } from "./credentials.js";
import { initDb, query, setPool } from "./db.js";
import {
  acknowledgeClaim,
  acknowledgeRotation,
  assertLegacyEnrollmentAllowed,
  bindLegacyCredentialWithClaimLock,
  cancelClaim,
  canonicalJson,
  claimKeysConfigured,
  cleanupPeonClaims,
  credentialVerifier,
  decideClaim,
  identityKeyId,
  pollClaim,
  resolveClaim,
  resolvePc1Credential,
  revokeClaimCredential,
  revokeClaimPeon,
  revocationTargetExists,
  semanticRequestHash,
  sha256Base64url,
  startClaim,
  startRotation,
  type PublicJwk,
} from "./modules/peonClaims/index.js";
import {
  claimPeonConnection,
  evictPeonConnectionsBelowGeneration,
} from "./peonConnections.js";
import { attachPeonSocket } from "./peonSocket.js";
import {
  claimPeonTransferConnection,
  evictPeonTransferConnectionsBelowGeneration,
} from "./peonTransferConnections.js";
import { attachPeonTransferSocket, PEON_TRANSFER_SOCKET_PATH } from "./peonTransferSocket.js";
import { registry, toView } from "./registry.js";
import { createServer } from "./server.js";
import { membership } from "./workspaces.js";

interface Identity {
  peonId: string;
  keyId: string;
  publicKey: PublicJwk;
  privateKey: KeyObject;
}

function identity(): Identity {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" }) as PublicJwk;
  return { peonId: randomUUID(), keyId: identityKeyId(publicKey), publicKey, privateKey: pair.privateKey };
}

function proof(
  identityValue: Identity,
  body: Record<string, unknown>,
  path: string,
  bindingNonce: string | null,
  issuedAt: number,
  requestNonce = randomBytes(16).toString("base64url"),
): Record<string, unknown> {
  body.proof = { issuedAt, requestNonce, signature: "" };
  const unsigned = {
    capability: "peon-claim-v1",
    protocol: 1,
    serverOrigin: config.publicUrl,
    method: "POST",
    path,
    bindingNonce,
    body: {
      ...body,
      proof: { issuedAt, requestNonce },
    },
  };
  (body.proof as Record<string, unknown>).signature = sign(
    null,
    Buffer.from(canonicalJson(unsigned)),
    identityValue.privateKey,
  ).toString("base64url");
  return body;
}

function claimStart(
  identityValue: Identity,
  now: number,
  claimToken: string,
  attemptId = randomUUID(),
  claimNonce = randomBytes(32).toString("base64url"),
  requestNonce?: string,
): Record<string, unknown> {
  return proof(identityValue, {
    type: "claim_start",
    protocol: 1,
    capability: "peon-claim-v1",
    attemptId,
    peonId: identityValue.peonId,
    serverOrigin: config.publicUrl,
    claimNonce,
    claimTokenHash: sha256Base64url(Buffer.from(claimToken, "base64url")),
    identity: {
      algorithm: "Ed25519",
      keyId: identityValue.keyId,
      publicKey: identityValue.publicKey,
    },
    display: {
      name: "NAT-only Nova",
      platform: "darwin",
      architecture: "arm64",
      daemonVersion: "0.12.0",
    },
  }, "/api/v1/peon-claims", claimNonce, now, requestNonce);
}

function signedClaim(
  identityValue: Identity,
  type: "claim_poll" | "claim_ack",
  claimId: string,
  claimNonce: string,
  now: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const suffix = type === "claim_poll" ? "poll" : "ack";
  return proof(identityValue, { type, protocol: 1, claimId, ...extra },
    `/api/v1/peon-claims/${claimId}/${suffix}`, claimNonce, now);
}

async function jsonPost(
  port: number,
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("peon-claim-v1 is restart-safe, replay-safe, ACL-scoped, encrypted at rest, rotatable and revocable", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;
  await initDb(pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");

  const ownerId = randomUUID();
  const memberId = randomUUID();
  const workspaceId = randomUUID();
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'owner@test',1),($2,'member@test',1)`, [ownerId, memberId]);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Claims','claims',$2,1)`, [workspaceId, ownerId]);
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ($1,$2,'owner',1),($1,$3,'member',1)`,
    [workspaceId, ownerId, memberId],
  );
  const ownerDevice = await issueDevice(ownerId, "test", { ip: null, userAgent: null });
  const memberDevice = await issueDevice(memberId, "test", { ip: null, userAgent: null });

  const machine = identity();
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const start = claimStart(machine, now, token);
  const created = await startClaim(start, "192.0.2.10", now);
  const claimId = String(created.claimId);
  assert.equal(created.state, "pending");
  assert.equal(created.replayed, false);
  await assert.rejects(
    assertLegacyEnrollmentAllowed(machine.peonId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENROLLMENT_METHOD_LOCKED",
  );

  // All idempotency state is durable: re-running migrations simulates a fresh
  // service process over the same Postgres state.
  setPool(pool);
  proof(machine, start, "/api/v1/peon-claims", String(start.claimNonce), now + 100);
  const replay = await startClaim(start, "192.0.2.10", now + 100);
  assert.equal(replay.claimId, claimId);
  assert.equal(replay.replayed, true);

  const changed = structuredClone(start);
  (changed.display as Record<string, unknown>).name = "changed";
  proof(machine, changed, "/api/v1/peon-claims", String(changed.claimNonce), now + 200);
  await assert.rejects(
    startClaim(changed, "192.0.2.10", now + 200),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ATTEMPT_ID_REUSED",
  );

  const nonceReplayToken = randomBytes(32).toString("base64url");
  const reusedNonce = String((start.proof as Record<string, unknown>).requestNonce);
  assert.equal((await query(
    `SELECT 1 FROM peon_claim_request_nonces WHERE identity_key_id=$1 AND request_nonce=$2`,
    [machine.keyId, reusedNonce],
  )).rows.length, 1);
  const nonceReplay = claimStart(machine, now + 300, nonceReplayToken, randomUUID(), undefined, reusedNonce);
  await assert.rejects(
    startClaim(nonceReplay, "192.0.2.10", now + 300),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "REQUEST_REPLAYED",
  );
  const server = http.createServer(createServer());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const resolved = await jsonPost(port, "/api/peon-claims/resolve", ownerDevice.token, {
      type: "claim_resolve", protocol: 1, operatorCode: created.operatorCode,
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(Object.keys(resolved.body).sort(), [
      "claimId", "createdAt", "display", "expiresAt", "identityKeyId", "peonId", "protocol", "serverTime", "state", "type",
    ]);

    const memberDecision = await jsonPost(
      port,
      `/api/workspaces/${workspaceId}/peon-claims/${claimId}/decision`,
      memberDevice.token,
      { type: "claim_decision", protocol: 1, claimId, decision: "approve" },
    );
    assert.equal(memberDecision.status, 403);
    assert.equal(memberDecision.body.code, "FORBIDDEN");
    assert.equal(memberDecision.body.type, "claim_error");

    const ownerDecision = await jsonPost(
      port,
      `/api/workspaces/${workspaceId}/peon-claims/${claimId}/decision`,
      ownerDevice.token,
      { type: "claim_decision", protocol: 1, claimId, decision: "approve" },
    );
    assert.equal(ownerDecision.status, 200);
    assert.equal(ownerDecision.body.mode, "new");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const claimNonce = String(start.claimNonce);
  const status = await pollClaim(
    claimId,
    signedClaim(machine, "claim_poll", claimId, claimNonce, now + 2_000),
    token,
    now + 2_000,
  );
  assert.equal(status.state, "approved", JSON.stringify(status));
  await assert.rejects(
    pollClaim(
      claimId,
      signedClaim(machine, "claim_poll", claimId, claimNonce, now + 2_000),
      token,
      now + 2_000,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "RATE_LIMITED",
  );
  const delivery = status.delivery as Record<string, unknown>;
  const bearer = String(delivery.bearer);
  assert.match(bearer, /^pc1\./);
  const sealedBeforeAck = (await query<{ ciphertext: string }>(
    `SELECT ciphertext FROM peon_claim_deliveries WHERE owner_id=$1`,
    [claimId],
  )).rows[0];
  assert.ok(sealedBeforeAck?.ciphertext);
  const credentialBeforeAck = (await query<{ verifier: string }>(
    `SELECT verifier FROM peon_claim_credentials WHERE id=$1`,
    [delivery.credentialId],
  )).rows[0];
  assert.notEqual(credentialBeforeAck.verifier, bearer);

  const completed = await acknowledgeClaim(
    claimId,
    signedClaim(machine, "claim_ack", claimId, claimNonce, now + 3_000, {
      deliveryId: delivery.deliveryId,
      credentialId: delivery.credentialId,
      generation: delivery.generation,
    }),
    bearer,
    now + 3_000,
  );
  assert.equal(completed.state, "completed");
  const completedReplay = await acknowledgeClaim(
    claimId,
    signedClaim(machine, "claim_ack", claimId, claimNonce, now + 3_500, {
      deliveryId: delivery.deliveryId,
      credentialId: delivery.credentialId,
      generation: delivery.generation,
    }),
    bearer,
    now + 3_500,
  );
  assert.equal(completedReplay.replayed, true);
  assert.equal((await query(`SELECT 1 FROM peon_claim_deliveries WHERE owner_id=$1`, [claimId])).rowCount, 0);
  const peon = (await query<{ token: string; credential_id: string }>(`SELECT token,credential_id FROM peons WHERE peon_id=$1`, [machine.peonId])).rows[0];
  assert.equal(peon.token, "");
  assert.equal(peon.credential_id, delivery.credentialId);
  assert.equal((await resolvePc1Credential(bearer))?.generation, 1);

  const rotationId = randomUUID();
  const rotationStart: Record<string, unknown> = {
    type: "credential_rotation_start",
    protocol: 1,
    capability: "peon-claim-v1",
    rotationId,
    peonId: machine.peonId,
    identityKeyId: machine.keyId,
    currentCredentialId: delivery.credentialId,
    currentGeneration: 1,
    serverOrigin: config.publicUrl,
  };
  proof(machine, rotationStart, "/api/v1/peon-credentials/rotations", null, now + 4_000);
  const persistedRotationStart = structuredClone(rotationStart);
  const rotation = await startRotation(rotationStart, bearer, now + 4_000);
  const rotatedDelivery = rotation.delivery as Record<string, unknown>;
  const rotatedBearer = String(rotatedDelivery.bearer);
  setPool(pool);
  await assert.rejects(
    startRotation(persistedRotationStart, bearer, now + 124_001),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLOCK_SKEW",
  );
  proof(machine, rotationStart, "/api/v1/peon-credentials/rotations", null, now + 124_001);
  const rotationReplay = await startRotation(rotationStart, bearer, now + 124_001);
  assert.equal(rotationReplay.replayed, true);
  assert.equal((rotationReplay.delivery as Record<string, unknown>).bearer, rotatedBearer);
  for (let retry = 1; retry <= 4; retry += 1) {
    proof(machine, rotationStart, "/api/v1/peon-credentials/rotations", null, now + 124_001 + retry);
    assert.equal((await startRotation(rotationStart, bearer, now + 124_001 + retry)).replayed, true);
  }
  assert.equal(Number((await query<{ count: number }>(
    `SELECT count FROM peon_claim_rate_limits WHERE scope='rotation-peon'`,
  )).rows[0]?.count), 1);
  const rotationAck: Record<string, unknown> = {
    type: "credential_rotation_ack",
    protocol: 1,
    rotationId,
    deliveryId: rotatedDelivery.deliveryId,
    credentialId: rotatedDelivery.credentialId,
    generation: rotatedDelivery.generation,
  };
  proof(machine, rotationAck, `/api/v1/peon-credentials/rotations/${rotationId}/ack`, null, now + 5_000);
  const persistedRotationAck = structuredClone(rotationAck);
  const rotated = await acknowledgeRotation(rotationId, rotationAck, rotatedBearer, now + 5_000);
  assert.equal(rotated.generation, 2);
  setPool(pool);
  await assert.rejects(
    acknowledgeRotation(rotationId, persistedRotationAck, rotatedBearer, now + 125_001),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLOCK_SKEW",
  );
  proof(machine, rotationAck, `/api/v1/peon-credentials/rotations/${rotationId}/ack`, null, now + 125_001);
  assert.equal((await acknowledgeRotation(rotationId, rotationAck, rotatedBearer, now + 125_001)).replayed, true);
  const changedRotationAck = structuredClone(rotationAck);
  changedRotationAck.generation = Number(changedRotationAck.generation) + 1;
  proof(machine, changedRotationAck, `/api/v1/peon-credentials/rotations/${rotationId}/ack`, null, now + 125_100);
  await assert.rejects(
    acknowledgeRotation(rotationId, changedRotationAck, rotatedBearer, now + 125_100),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ROTATION_ACK_MISMATCH",
  );
  assert.equal(await resolvePc1Credential(bearer), null);
  assert.equal((await resolvePc1Credential(rotatedBearer))?.generation, 2);

  assert.equal((await revokeClaimCredential(
    workspaceId,
    machine.peonId,
    String(rotatedDelivery.credentialId),
    ownerId,
    undefined,
    now + 6_000,
  ))?.changed, true);
  assert.equal(await resolvePc1Credential(rotatedBearer), null);

  const recoveryToken = randomBytes(32).toString("base64url");
  const recoveryStart = claimStart(machine, now + 7_000, recoveryToken);
  const recoveryCreated = await startClaim(recoveryStart, "192.0.2.10", now + 7_000);
  await resolveClaim({
    type: "claim_resolve",
    protocol: 1,
    operatorCode: recoveryCreated.operatorCode,
  }, "192.0.2.10", ownerId, now + 7_100);
  const recoveryDecision = await decideClaim(
    workspaceId,
    String(recoveryCreated.claimId),
    "approve",
    ownerId,
    now + 7_200,
  );
  assert.equal(recoveryDecision.mode, "recover");
  const recoveryNonce = String(recoveryStart.claimNonce);
  const recoveryStatus = await pollClaim(
    String(recoveryCreated.claimId),
    signedClaim(machine, "claim_poll", String(recoveryCreated.claimId), recoveryNonce, now + 9_000),
    recoveryToken,
    now + 9_000,
  );
  const recoveryDelivery = recoveryStatus.delivery as Record<string, unknown>;
  const recoveryBearer = String(recoveryDelivery.bearer);
  const recoveryCompleted = await acknowledgeClaim(
    String(recoveryCreated.claimId),
    signedClaim(machine, "claim_ack", String(recoveryCreated.claimId), recoveryNonce, now + 10_000, {
      deliveryId: recoveryDelivery.deliveryId,
      credentialId: recoveryDelivery.credentialId,
      generation: recoveryDelivery.generation,
    }),
    recoveryBearer,
    now + 10_000,
  );
  assert.equal(recoveryCompleted.generation, 3);
  assert.equal((await resolvePc1Credential(recoveryBearer))?.generation, 3);

  const otherWorkspaceId = randomUUID();
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Other','other',$2,1)`,
    [otherWorkspaceId, ownerId],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ($1,$2,'owner',1)`,
    [otherWorkspaceId, ownerId],
  );
  const crossToken = randomBytes(32).toString("base64url");
  const crossNow = now + 3_700_000;
  const crossStart = claimStart(machine, crossNow, crossToken);
  const crossCreated = await startClaim(crossStart, "192.0.2.10", crossNow);
  await resolveClaim({
    type: "claim_resolve",
    protocol: 1,
    operatorCode: crossCreated.operatorCode,
  }, "192.0.2.10", ownerId, crossNow + 100);
  await assert.rejects(
    decideClaim(otherWorkspaceId, String(crossCreated.claimId), "approve", ownerId, crossNow + 200),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PEON_ALREADY_CLAIMED",
  );

  const serializedRows = JSON.stringify((await query(
    `SELECT verifier,state FROM peon_claim_credentials WHERE peon_id=$1`,
    [machine.peonId],
  )).rows);
  assert.equal(serializedRows.includes(bearer), false);
  assert.equal(serializedRows.includes(rotatedBearer), false);
  assert.notEqual(semanticRequestHash(start, ["attemptId", "proof"]), "");
});

test("request nonce retention is exact at and after the 24-hour boundary without cleanup", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const machine = identity();
  const start = claimStart(machine, now, randomBytes(32).toString("base64url"));
  await startClaim(start, "198.51.100.210", now);
  const admittedNonce = String((start.proof as Record<string, unknown>).requestNonce);

  const atBoundary = structuredClone(start);
  proof(
    machine,
    atBoundary,
    "/api/v1/peon-claims",
    String(atBoundary.claimNonce),
    now + 86_400_000,
    admittedNonce,
  );
  await assert.rejects(
    startClaim(atBoundary, "198.51.100.210", now + 86_400_000),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "REQUEST_REPLAYED",
  );

  const afterBoundary = structuredClone(start);
  proof(
    machine,
    afterBoundary,
    "/api/v1/peon-claims",
    String(afterBoundary.claimNonce),
    now + 86_400_001,
    admittedNonce,
  );
  await assert.rejects(
    startClaim(afterBoundary, "198.51.100.210", now + 86_400_001),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLAIM_EXPIRED",
  );
  assert.equal((await query<{ created_at: number }>(
    `SELECT created_at FROM peon_claim_request_nonces
     WHERE identity_key_id=$1 AND request_nonce=$2`,
    [machine.keyId, admittedNonce],
  )).rows[0]?.created_at, now + 86_400_001);
});

test("credential generation fencing rejects delayed lower-generation control and transfer claims", () => {
  let newerControlTerminated = 0;
  let staleControlTerminated = 0;
  let newerTransferTerminated = 0;
  let staleTransferTerminated = 0;
  const newerControl = { terminate: () => { newerControlTerminated += 1; } } as unknown as WebSocket;
  const staleControl = { terminate: () => { staleControlTerminated += 1; } } as unknown as WebSocket;
  const newerTransfer = { terminate: () => { newerTransferTerminated += 1; } } as unknown as WebSocket;
  const staleTransfer = { terminate: () => { staleTransferTerminated += 1; } } as unknown as WebSocket;
  const peonId = randomUUID();
  assert.equal(claimPeonConnection(peonId, newerControl, [], [], 2).accepted, true);
  assert.equal(claimPeonTransferConnection(peonId, newerTransfer, [], 2).accepted, true);
  assert.equal(claimPeonConnection(peonId, staleControl, [], [], 1).accepted, false);
  assert.equal(claimPeonTransferConnection(peonId, staleTransfer, [], 1).accepted, false);
  assert.equal(evictPeonConnectionsBelowGeneration(peonId, 2), false);
  assert.equal(evictPeonTransferConnectionsBelowGeneration(peonId, 2), false);
  assert.equal(evictPeonConnectionsBelowGeneration(peonId, 3), true);
  assert.equal(evictPeonTransferConnectionsBelowGeneration(peonId, 3), true);
  assert.equal(newerControlTerminated, 1);
  assert.equal(newerTransferTerminated, 1);
  assert.equal(staleControlTerminated, 0);
  assert.equal(staleTransferTerminated, 0);
});

test("generation 2 hellos stay authoritative when delayed generation 1 hellos arrive", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const workspaceId = randomUUID();
  const machine = identity();
  const now = Date.now();
  const firstId = randomUUID();
  const secondId = randomUUID();
  const firstBearer = `pc1.${firstId}.${randomBytes(32).toString("base64url")}`;
  const secondBearer = `pc1.${secondId}.${randomBytes(32).toString("base64url")}`;
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at)
     VALUES ($1,'Generation hello','generation-hello','owner',$2)`,
    [workspaceId, now],
  );
  await query(
    `INSERT INTO peon_identity_bindings
     (peon_id,identity_key_id,public_jwk,workspace_id,method,created_at,removed_at)
     VALUES ($1,$2,$3,$4,'claim',$5,NULL)`,
    [machine.peonId, machine.keyId, JSON.stringify(machine.publicKey), workspaceId, now],
  );
  await query(
    `INSERT INTO peon_claim_credentials
     (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_at,activated_at)
     VALUES ($1,$2,$3,$4,1,'active',$5,1,$7,$7),
            ($6,$2,$3,$4,2,'active',$8,1,$7,$7)`,
    [firstId, workspaceId, machine.peonId, machine.keyId, credentialVerifier(firstBearer), secondId, now, credentialVerifier(secondBearer)],
  );
  await registry.register({
    peonId: machine.peonId,
    credentialId: firstId,
    workspaceId,
    name: "Generation hello",
    hostname: null,
    address: "",
    controlPort: 0,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token: "",
    load: null,
  });
  assert.equal(toView((await registry.get(machine.peonId))!).baseUrl, null);
  const server = http.createServer();
  const controlWss = attachPeonSocket(server);
  const transferWss = attachPeonTransferSocket(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const openSocket = (path: string, bearer: string) => new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
  const message = (socket: WebSocket) => new Promise<Record<string, unknown>>((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
  });
  const closed = (socket: WebSocket) => new Promise<{ code: number; reason: string }>((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const opened = new Set<WebSocket>();
  try {
    const staleControl = await openSocket("/api/v1/peons/ws", firstBearer);
    opened.add(staleControl);
    const staleTransfer = await openSocket(PEON_TRANSFER_SOCKET_PATH, firstBearer);
    opened.add(staleTransfer);
    await query(`UPDATE peons SET credential_id=$2 WHERE peon_id=$1`, [machine.peonId, secondId]);
    const newerControl = await openSocket("/api/v1/peons/ws", secondBearer);
    opened.add(newerControl);
    const newerTransfer = await openSocket(PEON_TRANSFER_SOCKET_PATH, secondBearer);
    opened.add(newerTransfer);

    const newerControlAck = message(newerControl);
    newerControl.send(JSON.stringify({ type: "hello", protocol: 1 }));
    assert.deepEqual(await newerControlAck, { type: "hello_ack", protocol: 1, capabilities: [] });
    const newerTransferAck = message(newerTransfer);
    newerTransfer.send(JSON.stringify({ type: "hello", protocol: 1, channel: "file-transfer", capabilities: [] }));
    assert.deepEqual(await newerTransferAck, {
      type: "hello_ack",
      protocol: 1,
      channel: "file-transfer",
      capabilities: [],
    });

    const staleControlClosed = closed(staleControl);
    staleControl.send(JSON.stringify({ type: "hello", protocol: 1 }));
    const staleTransferClosed = closed(staleTransfer);
    staleTransfer.send(JSON.stringify({ type: "hello", protocol: 1, channel: "file-transfer", capabilities: [] }));
    assert.deepEqual(await staleControlClosed, { code: 4001, reason: "rejected stale credential generation" });
    assert.deepEqual(await staleTransferClosed, { code: 4001, reason: "rejected stale credential generation" });
    assert.equal(newerControl.readyState, WebSocket.OPEN);
    assert.equal(newerTransfer.readyState, WebSocket.OPEN);
    newerControl.close();
    newerTransfer.close();
  } finally {
    for (const socket of opened) socket.terminate();
    await new Promise<void>((resolve) => controlWss.close(() => resolve()));
    await new Promise<void>((resolve) => transferWss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("public claim admission rejects bad signatures and enforces the frozen source-IP rate", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();

  await query(
    `INSERT INTO peon_claim_request_nonces (identity_key_id,request_nonce,created_at,expires_at)
     VALUES ('expired-seed','expired-seed',1,$1)`,
    [now - 1],
  );
  await assert.rejects(
    startClaim({}, "198.51.100.9", now),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BAD_REQUEST",
  );
  assert.equal((await query(
    `SELECT 1 FROM peon_claim_request_nonces WHERE identity_key_id='expired-seed'`,
  )).rows.length, 1, "unauthenticated malformed starts cannot trigger cleanup");

  const staleIdentity = identity();
  await assert.rejects(
    startClaim(
      claimStart(staleIdentity, now - 120_001, randomBytes(32).toString("base64url")),
      "198.51.100.9",
      now,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLOCK_SKEW",
  );
  assert.equal((await query(`SELECT 1 FROM peon_claim_rate_limits`)).rows.length, 0);

  const forgedIdentity = identity();
  const forged = claimStart(forgedIdentity, now, randomBytes(32).toString("base64url"));
  const proofValue = forged.proof as Record<string, unknown>;
  const signatureValue = String(proofValue.signature);
  proofValue.signature = `${signatureValue.slice(0, -1)}${signatureValue.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    startClaim(forged, "198.51.100.9", now),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "BAD_SIGNATURE",
  );
  assert.equal((await query(`SELECT 1 FROM peon_claim_rate_limits`)).rows.length, 0);

  for (let index = 0; index < 5; index += 1) {
    const machine = identity();
    await startClaim(
      claimStart(machine, now + index + 1, randomBytes(32).toString("base64url")),
      "198.51.100.9",
      now + index + 1,
    );
  }
  const sixth = identity();
  await assert.rejects(
    startClaim(claimStart(sixth, now + 10, randomBytes(32).toString("base64url")), "198.51.100.9", now + 10),
    (error: unknown) => error instanceof Error && "code" in error
      && error.code === "RATE_LIMITED"
      && "extra" in error
      && typeof (error.extra as Record<string, unknown>).retryAfterMs === "number",
  );
});

test("production Host guard precedes strict public claim parsing and the app parser", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const server = http.createServer(createServer());
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const request = (
    method: "GET" | "POST",
    path: string,
    host: string,
    raw?: string,
  ) => new Promise<{ status: number; contentType: string; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        host,
        ...(raw === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(raw)),
        }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers["content-type"] ?? ""),
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
  try {
    const wrongCapabilities = await request(
      "GET",
      "/api/v1/peon-claims/capabilities",
      "attacker.example",
    );
    assert.equal(wrongCapabilities.status, 421);
    assert.deepEqual(wrongCapabilities.body, {
      error: "request host is not served here",
      code: "MISDIRECTED_REQUEST",
    });
    const wrongPost = await request("POST", "/api/v1/peon-claims", "attacker.example", "{");
    assert.equal(wrongPost.status, 421);
    assert.deepEqual(wrongPost.body, {
      error: "request host is not served here",
      code: "MISDIRECTED_REQUEST",
    });

    for (const raw of ["{", JSON.stringify({ padding: "x".repeat(16_384) })]) {
      const response = await request("POST", "/api/v1/peon-claims", "overseer.example.test", raw);
      assert.equal(response.status, 400);
      assert.match(response.contentType, /^application\/json/);
      assert.deepEqual(Object.keys(response.body).sort(), ["code", "message", "protocol", "serverTime", "type"]);
      assert.equal(response.body.type, "claim_error");
      assert.equal(response.body.protocol, 1);
      assert.equal(response.body.code, "BAD_REQUEST");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("claim capability requires three pairwise-distinct canonical keys", () => {
  config.peonClaimEnabled = true;
  const repeated = randomBytes(32).toString("base64url");
  config.peonClaimCredentialPepper = repeated;
  config.peonClaimDeliveryKey = repeated;
  config.peonClaimOperatorCodeKey = repeated;
  assert.equal(claimKeysConfigured(), false);
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  assert.equal(claimKeysConfigured(), true);
});

test("cancellation, denial and expiry are durable terminal transitions with secret cleanup", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const userId = randomUUID();
  const workspaceId = randomUUID();
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'terminal@test',$2)`, [userId, now]);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Terminal','terminal',$2,$3)`, [workspaceId, userId, now]);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ($1,$2,'owner',$3)`, [workspaceId, userId, now]);

  const cancelledMachine = identity();
  const cancelledToken = randomBytes(32).toString("base64url");
  const cancelledStart = claimStart(cancelledMachine, now, cancelledToken);
  const cancelledCreated = await startClaim(cancelledStart, "203.0.113.8", now);
  const cancelBody = proof(cancelledMachine, {
    type: "claim_cancel",
    protocol: 1,
    claimId: cancelledCreated.claimId,
  }, `/api/v1/peon-claims/${cancelledCreated.claimId}/cancel`, String(cancelledStart.claimNonce), now + 1_000);
  const cancelled = await cancelClaim(String(cancelledCreated.claimId), cancelBody, cancelledToken, now + 1_000);
  assert.equal(cancelled.type, "claim_cancel_result");
  assert.equal(cancelled.changed, true);
  proof(cancelledMachine, cancelBody, `/api/v1/peon-claims/${cancelledCreated.claimId}/cancel`, String(cancelledStart.claimNonce), now + 1_100);
  await assert.rejects(
    cancelClaim(String(cancelledCreated.claimId), cancelBody, cancelledToken, now + 1_100),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNAUTHENTICATED",
  );
  const cancelledRow = (await query<{ claim_token_hash: string | null; operator_code_hash: string | null }>(
    `SELECT claim_token_hash,operator_code_hash FROM peon_claims WHERE claim_id=$1`,
    [cancelledCreated.claimId],
  )).rows[0];
  assert.equal(cancelledRow.claim_token_hash, null);
  assert.equal(cancelledRow.operator_code_hash, null);

  const deniedMachine = identity();
  const deniedToken = randomBytes(32).toString("base64url");
  const deniedStart = claimStart(deniedMachine, now + 2_000, deniedToken);
  const deniedCreated = await startClaim(deniedStart, "203.0.113.8", now + 2_000);
  await resolveClaim({
    type: "claim_resolve",
    protocol: 1,
    operatorCode: deniedCreated.operatorCode,
  }, "203.0.113.8", userId, now + 2_100);
  const denial = await decideClaim(workspaceId, String(deniedCreated.claimId), "deny", userId, now + 2_200);
  assert.equal(denial.state, "denied");
  const denialObservation = proof(deniedMachine, {
    type: "claim_cancel", protocol: 1, claimId: deniedCreated.claimId,
  }, `/api/v1/peon-claims/${deniedCreated.claimId}/cancel`, String(deniedStart.claimNonce), now + 4_000);
  const deniedStatus = await cancelClaim(String(deniedCreated.claimId), denialObservation, deniedToken, now + 4_000);
  assert.equal(deniedStatus.code, "CLAIM_DENIED");
  assert.equal(deniedStatus.changed, false);
  proof(deniedMachine, denialObservation, `/api/v1/peon-claims/${deniedCreated.claimId}/cancel`, String(deniedStart.claimNonce), now + 4_100);
  await assert.rejects(
    cancelClaim(String(deniedCreated.claimId), denialObservation, deniedToken, now + 4_100),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNAUTHENTICATED",
  );
  assert.equal((await query<{ claim_token_hash: string | null }>(
    `SELECT claim_token_hash FROM peon_claims WHERE claim_id=$1`,
    [deniedCreated.claimId],
  )).rows[0].claim_token_hash, null);

  const expiredMachine = identity();
  const expiredToken = randomBytes(32).toString("base64url");
  const expiredStart = claimStart(expiredMachine, now + 5_000, expiredToken);
  const expiredCreated = await startClaim(expiredStart, "203.0.113.8", now + 5_000);
  const expiredAt = now + 5_000 + 600_001;
  const expiredStatus = await pollClaim(
    String(expiredCreated.claimId),
    signedClaim(expiredMachine, "claim_poll", String(expiredCreated.claimId), String(expiredStart.claimNonce), expiredAt),
    expiredToken,
    expiredAt,
  );
  assert.equal(expiredStatus.code, "CLAIM_EXPIRED");

  const decisionExpiredMachine = identity();
  const decisionExpiredStartAt = now + 10_000;
  const decisionExpiredStart = claimStart(
    decisionExpiredMachine,
    decisionExpiredStartAt,
    randomBytes(32).toString("base64url"),
  );
  const decisionExpiredCreated = await startClaim(
    decisionExpiredStart,
    "203.0.113.9",
    decisionExpiredStartAt,
  );
  await resolveClaim({
    type: "claim_resolve",
    protocol: 1,
    operatorCode: decisionExpiredCreated.operatorCode,
  }, "203.0.113.9", userId, decisionExpiredStartAt + 100);
  await assert.rejects(
    decideClaim(
      workspaceId,
      String(decisionExpiredCreated.claimId),
      "approve",
      userId,
      decisionExpiredStartAt + 600_000,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLAIM_NOT_FOUND",
  );
  const decisionExpiredRow = (await query<{
    state: string;
    operator_code_hash: string | null;
  }>(
    `SELECT state,operator_code_hash FROM peon_claims WHERE claim_id=$1`,
    [decisionExpiredCreated.claimId],
  )).rows[0];
  assert.deepEqual(decisionExpiredRow, { state: "expired", operator_code_hash: null });
  assert.equal((await query(
    `SELECT 1 FROM peon_enrollment_leases WHERE claim_id=$1`,
    [decisionExpiredCreated.claimId],
  )).rows.length, 0);

  const deliveryExpiredMachine = identity();
  const deliveryExpiredStartAt = now + 11_000;
  const deliveryExpiredStart = claimStart(
    deliveryExpiredMachine,
    deliveryExpiredStartAt,
    randomBytes(32).toString("base64url"),
  );
  const deliveryExpiredCreated = await startClaim(
    deliveryExpiredStart,
    "203.0.113.10",
    deliveryExpiredStartAt,
  );
  await resolveClaim({
    type: "claim_resolve",
    protocol: 1,
    operatorCode: deliveryExpiredCreated.operatorCode,
  }, "203.0.113.10", userId, deliveryExpiredStartAt + 100);
  const deliveryApproval = await decideClaim(
    workspaceId,
    String(deliveryExpiredCreated.claimId),
    "approve",
    userId,
    deliveryExpiredStartAt + 200,
  );
  const deliveryExpiresAt = Number(deliveryApproval.deliveryExpiresAt);
  await assert.rejects(
    decideClaim(
      workspaceId,
      String(deliveryExpiredCreated.claimId),
      "approve",
      userId,
      deliveryExpiresAt,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLAIM_NOT_FOUND",
  );
  assert.equal((await query<{ state: string }>(
    `SELECT state FROM peon_claims WHERE claim_id=$1`,
    [deliveryExpiredCreated.claimId],
  )).rows[0].state, "expired");
  assert.equal((await query<{ state: string }>(
    `SELECT state FROM peon_claim_credentials WHERE id=$1`,
    [deliveryApproval.credentialId],
  )).rows[0].state, "revoked");
  assert.equal((await query(
    `SELECT 1 FROM peon_claim_deliveries WHERE owner_id=$1`,
    [deliveryExpiredCreated.claimId],
  )).rows.length, 0);

  const race = async (offset: number) => {
    const raceMachine = identity();
    const raceToken = randomBytes(32).toString("base64url");
    const raceStart = claimStart(raceMachine, now + offset, raceToken);
    const raceCreated = await startClaim(raceStart, `198.51.100.${offset / 10_000}`, now + offset);
    await resolveClaim({
      type: "claim_resolve", protocol: 1, operatorCode: raceCreated.operatorCode,
    }, "198.51.100.40", userId, now + offset + 100);
    await decideClaim(workspaceId, String(raceCreated.claimId), "approve", userId, now + offset + 200);
    const raceStatus = await pollClaim(
      String(raceCreated.claimId),
      signedClaim(raceMachine, "claim_poll", String(raceCreated.claimId), String(raceStart.claimNonce), now + offset + 2_500),
      raceToken,
      now + offset + 2_500,
    );
    return { raceMachine, raceToken, raceStart, raceCreated, delivery: raceStatus.delivery as Record<string, unknown> };
  };

  const cancelWins = await race(20_000);
  const cancelWinsBody = proof(cancelWins.raceMachine, {
    type: "claim_cancel", protocol: 1, claimId: cancelWins.raceCreated.claimId,
  }, `/api/v1/peon-claims/${cancelWins.raceCreated.claimId}/cancel`, String(cancelWins.raceStart.claimNonce), now + 24_500);
  await cancelClaim(String(cancelWins.raceCreated.claimId), cancelWinsBody, cancelWins.raceToken, now + 24_500);
  await assert.rejects(
    acknowledgeClaim(
      String(cancelWins.raceCreated.claimId),
      signedClaim(cancelWins.raceMachine, "claim_ack", String(cancelWins.raceCreated.claimId), String(cancelWins.raceStart.claimNonce), now + 24_600, {
        deliveryId: cancelWins.delivery.deliveryId,
        credentialId: cancelWins.delivery.credentialId,
        generation: cancelWins.delivery.generation,
      }),
      String(cancelWins.delivery.bearer),
      now + 24_600,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CREDENTIAL_REVOKED",
  );

  const ackWins = await race(40_000);
  await acknowledgeClaim(
    String(ackWins.raceCreated.claimId),
    signedClaim(ackWins.raceMachine, "claim_ack", String(ackWins.raceCreated.claimId), String(ackWins.raceStart.claimNonce), now + 43_000, {
      deliveryId: ackWins.delivery.deliveryId,
      credentialId: ackWins.delivery.credentialId,
      generation: ackWins.delivery.generation,
    }),
    String(ackWins.delivery.bearer),
    now + 43_000,
  );
  const losingCancel = proof(ackWins.raceMachine, {
    type: "claim_cancel", protocol: 1, claimId: ackWins.raceCreated.claimId,
  }, `/api/v1/peon-claims/${ackWins.raceCreated.claimId}/cancel`, String(ackWins.raceStart.claimNonce), now + 45_000);
  await assert.rejects(
    cancelClaim(String(ackWins.raceCreated.claimId), losingCancel, ackWins.raceToken, now + 45_000),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNAUTHENTICATED",
  );
});

test("fresh proofs recover semantic start and ACK results across restart and retention boundaries", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool() as unknown as pg.Pool;
  await initDb(pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'proofs@test',$2)`, [ownerId, now]);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Proofs','proofs',$2,$3)`, [workspaceId, ownerId, now]);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ($1,$2,'owner',$3)`, [workspaceId, ownerId, now]);

  const machine = identity();
  const claimToken = randomBytes(32).toString("base64url");
  const start = claimStart(machine, now, claimToken);
  const persistedProof = structuredClone(start);
  const created = await startClaim(start, "192.0.2.55", now);

  setPool(pool);
  await assert.rejects(
    startClaim(persistedProof, "192.0.2.55", now + 120_001),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLOCK_SKEW",
  );
  proof(machine, start, "/api/v1/peon-claims", String(start.claimNonce), now + 120_001);
  const replay = await startClaim(start, "192.0.2.55", now + 120_001);
  assert.equal(replay.replayed, true);
  assert.equal(replay.operatorCode, created.operatorCode);

  await resolveClaim({
    type: "claim_resolve", protocol: 1, operatorCode: created.operatorCode,
  }, "192.0.2.55", ownerId, now + 120_100);
  await decideClaim(workspaceId, String(created.claimId), "approve", ownerId, now + 120_200);
  const status = await pollClaim(
    String(created.claimId),
    signedClaim(machine, "claim_poll", String(created.claimId), String(start.claimNonce), now + 122_500),
    claimToken,
    now + 122_500,
  );
  const delivery = status.delivery as Record<string, unknown>;
  const ack = signedClaim(machine, "claim_ack", String(created.claimId), String(start.claimNonce), now + 123_000, {
    deliveryId: delivery.deliveryId,
    credentialId: delivery.credentialId,
    generation: delivery.generation,
  });
  const persistedAckProof = structuredClone(ack);
  await acknowledgeClaim(String(created.claimId), ack, String(delivery.bearer), now + 123_000);

  setPool(pool);
  await assert.rejects(
    acknowledgeClaim(String(created.claimId), persistedAckProof, String(delivery.bearer), now + 243_001),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLOCK_SKEW",
  );
  proof(machine, ack, `/api/v1/peon-claims/${created.claimId}/ack`, String(start.claimNonce), now + 243_001);
  const ackReplay = await acknowledgeClaim(String(created.claimId), ack, String(delivery.bearer), now + 243_001);
  assert.equal(ackReplay.replayed, true);

  const changedAck = structuredClone(ack);
  changedAck.generation = Number(changedAck.generation) + 1;
  proof(machine, changedAck, `/api/v1/peon-claims/${created.claimId}/ack`, String(start.claimNonce), now + 243_100);
  await assert.rejects(
    acknowledgeClaim(String(created.claimId), changedAck, String(delivery.bearer), now + 243_100),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLAIM_ACK_MISMATCH",
  );

  const afterResultRetention = now + 123_000 + 86_400_001;
  await cleanupPeonClaims(afterResultRetention);
  proof(machine, ack, `/api/v1/peon-claims/${created.claimId}/ack`, String(start.claimNonce), afterResultRetention);
  await assert.rejects(
    acknowledgeClaim(String(created.claimId), ack, String(delivery.bearer), afterResultRetention),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CLAIM_NOT_FOUND",
  );
});

test("operator revocation preserves concealment, CSRF, owner audit, idempotency and device-bearer exemption", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'revoke-owner@test',$3),($2,'revoke-member@test',$3)`, [ownerId, memberId, now]);
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at)
     VALUES ($1,'Revoke','revoke',$3,$4),($2,'Other revoke','other-revoke',$3,$4)`,
    [workspaceId, otherWorkspaceId, ownerId, now],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ($1,$2,'owner',$4),($1,$3,'member',$4),($5,$2,'owner',$4)`,
    [workspaceId, ownerId, memberId, now, otherWorkspaceId],
  );
  const machine = identity();
  await query(
    `INSERT INTO peon_identity_bindings
     (peon_id,identity_key_id,public_jwk,workspace_id,method,created_at,removed_at)
     VALUES ($1,$2,$3,$4,'claim',$5,NULL)`,
    [machine.peonId, machine.keyId, JSON.stringify(machine.publicKey), workspaceId, now],
  );
  const credentialId = randomUUID();
  const credentialBearer = `pc1.${credentialId}.${randomBytes(32).toString("base64url")}`;
  await query(
    `INSERT INTO peon_claim_credentials
     (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_at,activated_at)
     VALUES ($1,$2,$3,$4,1,'active',$5,1,$6,$6)`,
    [credentialId, workspaceId, machine.peonId, machine.keyId, credentialVerifier(credentialBearer), now],
  );
  const ownerDevice = await issueDevice(ownerId, "owner", { ip: null, userAgent: null });
  const memberDevice = await issueDevice(memberId, "member", { ip: null, userAgent: null });
  const server = http.createServer(createServer());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const path = `/api/workspaces/${workspaceId}/peons/${machine.peonId}/credentials/${credentialId}/revoke`;
  const body = { type: "credential_revocation", protocol: 1, credentialId };
  const post = async (target: string, headers: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${port}${target}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    const unauthenticated = await post(path, {});
    assert.deepEqual([unauthenticated.status, unauthenticated.body.type, unauthenticated.body.code], [401, "operator_error", "UNAUTHENTICATED"]);

    const csrf = await post(path, { cookie: `__Host-overseer_session=${ownerDevice.token}` });
    assert.deepEqual([csrf.status, csrf.body.type, csrf.body.code], [403, "operator_error", "CSRF_ORIGIN"]);

    const concealed = await post(
      `/api/workspaces/${otherWorkspaceId}/peons/${machine.peonId}/credentials/${credentialId}/revoke`,
      { authorization: `Bearer ${memberDevice.token}` },
    );
    assert.deepEqual([concealed.status, concealed.body.type, concealed.body.code], [404, "operator_error", "NOT_FOUND"]);
    assert.equal((await query(`SELECT 1 FROM peon_claim_audit`)).rows.length, 0);

    const forbidden = await post(path, { authorization: `Bearer ${memberDevice.token}` });
    assert.deepEqual([forbidden.status, forbidden.body.type, forbidden.body.code], [403, "operator_error", "FORBIDDEN"]);

    const revoked = await post(path, { authorization: `Bearer ${ownerDevice.token}`, "x-request-id": "revoke-first" });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.changed, true);
    assert.equal(revoked.body.revokedCredentialCount, 1);
    const revokedAt = revoked.body.revokedAt;

    const replayed = await post(path, { authorization: `Bearer ${ownerDevice.token}`, "x-request-id": "revoke-repeat" });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.changed, false);
    assert.equal(replayed.body.revokedAt, revokedAt);

    const secondId = randomUUID();
    const secondBearer = `pc1.${secondId}.${randomBytes(32).toString("base64url")}`;
    await query(
      `INSERT INTO peon_claim_credentials
       (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_at,activated_at)
       VALUES ($1,$2,$3,$4,2,'active',$5,1,$6,$6)`,
      [secondId, workspaceId, machine.peonId, machine.keyId, credentialVerifier(secondBearer), now + 1],
    );
    const peonPath = `/api/workspaces/${workspaceId}/peons/${machine.peonId}/revoke`;
    const peonResponse = await fetch(`http://127.0.0.1:${port}${peonPath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerDevice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "peon_revocation", protocol: 1, peonId: machine.peonId }),
    });
    const peonResult = await peonResponse.json() as Record<string, unknown>;
    assert.equal(peonResponse.status, 200);
    assert.equal(peonResult.code, "PEON_REVOKED");
    assert.equal(peonResult.changed, true);

    const audits = (await query<{ outcome: string; request_id: string }>(
      `SELECT outcome,request_id FROM peon_claim_audit ORDER BY created_at,id`,
    )).rows;
    assert.deepEqual(audits.map((row) => row.outcome).sort(), ["already_revoked", "forbidden", "revoked", "revoked"]);
    assert.equal(JSON.stringify(audits).includes(credentialBearer), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("approval transaction rejects an owner removed after the route-level observation", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'approval-race@test',$2)`, [ownerId, now]);
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at)
     VALUES ($1,'Approval race','approval-race',$2,$3)`,
    [workspaceId, ownerId, now],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ($1,$2,'owner',$3)`,
    [workspaceId, ownerId, now],
  );
  const machine = identity();
  const created = await startClaim(
    claimStart(machine, now + 1, randomBytes(32).toString("base64url")),
    "203.0.113.120",
    now + 1,
  );
  await resolveClaim({
    type: "claim_resolve",
    protocol: 1,
    operatorCode: created.operatorCode,
  }, "203.0.113.120", ownerId, now + 2);

  assert.equal(await membership(workspaceId, ownerId), "owner", "route-level authorization observed owner");
  await query(
    `UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`,
    [workspaceId, ownerId],
  );
  await assert.rejects(
    decideClaim(workspaceId, String(created.claimId), "approve", ownerId, now + 3),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "FORBIDDEN",
  );
  assert.equal((await query(`SELECT 1 FROM peon_claim_credentials WHERE peon_id=$1`, [machine.peonId])).rows.length, 0);
  assert.equal((await query(`SELECT 1 FROM peon_identity_bindings WHERE peon_id=$1`, [machine.peonId])).rows.length, 0);
});

test("revocation transactions recheck owner role after target concealment and before mutation", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const machine = identity();
  const credentialId = randomUUID();
  const claimBearer = `pc1.${credentialId}.${randomBytes(32).toString("base64url")}`;
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'revocation-race@test',$2)`, [ownerId, now]);
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at)
     VALUES ($1,'Revocation race','revocation-race',$2,$3)`,
    [workspaceId, ownerId, now],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ($1,$2,'owner',$3)`,
    [workspaceId, ownerId, now],
  );
  await query(
    `INSERT INTO peon_identity_bindings
     (peon_id,identity_key_id,public_jwk,workspace_id,method,created_at,removed_at)
     VALUES ($1,$2,$3,$4,'claim',$5,NULL)`,
    [machine.peonId, machine.keyId, JSON.stringify(machine.publicKey), workspaceId, now],
  );
  await query(
    `INSERT INTO peon_claim_credentials
     (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_at,activated_at)
     VALUES ($1,$2,$3,$4,1,'active',$5,1,$6,$6)`,
    [credentialId, workspaceId, machine.peonId, machine.keyId, credentialVerifier(claimBearer), now],
  );

  assert.equal(
    await revocationTargetExists("credential", workspaceId, machine.peonId, credentialId),
    true,
  );
  assert.equal(await membership(workspaceId, ownerId), "owner");
  await query(
    `UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`,
    [workspaceId, ownerId],
  );
  await assert.rejects(
    revokeClaimCredential(
      workspaceId,
      machine.peonId,
      credentialId,
      ownerId,
      "credential-role-race",
      now + 1,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "FORBIDDEN",
  );
  assert.equal((await query<{ state: string }>(
    `SELECT state FROM peon_claim_credentials WHERE id=$1`,
    [credentialId],
  )).rows[0].state, "active");

  await query(
    `UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2`,
    [workspaceId, ownerId],
  );
  assert.equal(await revocationTargetExists("peon", workspaceId, machine.peonId), true);
  assert.equal(await membership(workspaceId, ownerId), "owner");
  await query(
    `UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`,
    [workspaceId, ownerId],
  );
  await assert.rejects(
    revokeClaimPeon(workspaceId, machine.peonId, ownerId, "peon-role-race", now + 2),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "FORBIDDEN",
  );
  assert.equal((await query<{ state: string }>(
    `SELECT state FROM peon_claim_credentials WHERE id=$1`,
    [credentialId],
  )).rows[0].state, "active");
  const audits = (await query<{ scope: string; outcome: string; request_id: string }>(
    `SELECT scope,outcome,request_id FROM peon_claim_audit ORDER BY request_id`,
  )).rows;
  assert.deepEqual(audits, [
    { scope: "credential", outcome: "forbidden", request_id: "credential-role-race" },
    { scope: "peon", outcome: "forbidden", request_id: "peon-role-race" },
  ]);
});

test("fleet deletion atomically revokes legacy and pc1 credentials and blocks re-registration", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const machine = identity();
  const credentialId = randomUUID();
  const claimBearer = `pc1.${credentialId}.${randomBytes(32).toString("base64url")}`;
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'delete-owner@test',$2)`, [ownerId, now]);
  await query(
    `INSERT INTO workspaces (id,name,slug,created_by,created_at)
     VALUES ($1,'Delete claim','delete-claim',$2,$3)`,
    [workspaceId, ownerId, now],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id,user_id,role,added_at)
     VALUES ($1,$2,'owner',$3)`,
    [workspaceId, ownerId, now],
  );
  await query(
    `INSERT INTO peon_identity_bindings
     (peon_id,identity_key_id,public_jwk,workspace_id,method,created_at,removed_at)
     VALUES ($1,$2,$3,$4,'claim',$5,NULL)`,
    [machine.peonId, machine.keyId, JSON.stringify(machine.publicKey), workspaceId, now],
  );
  await query(
    `INSERT INTO peon_claim_credentials
     (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_at,activated_at)
     VALUES ($1,$2,$3,$4,1,'active',$5,1,$6,$6)`,
    [credentialId, workspaceId, machine.peonId, machine.keyId, credentialVerifier(claimBearer), now],
  );
  const legacy = await mintCredential(workspaceId, "migration-era legacy", ownerId);
  await query(`UPDATE peon_credentials SET bound_peon_id=$2 WHERE id=$1`, [legacy.credential.id, machine.peonId]);
  await registry.register({
    peonId: machine.peonId,
    credentialId,
    workspaceId,
    name: "Deleted NAT Peon",
    hostname: null,
    address: "",
    controlPort: 0,
    publicUrl: null,
    protocol: 1,
    capabilities: ["peon-claim-v1"],
    token: "",
    load: null,
  });
  const ownerDevice = await issueDevice(ownerId, "delete owner", { ip: null, userAgent: null });
  const server = http.createServer(createServer());
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  try {
    const removed = await fetch(
      `http://127.0.0.1:${port}/api/workspaces/${workspaceId}/peons/${machine.peonId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${ownerDevice.token}` } },
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });
    assert.equal(await resolvePc1Credential(claimBearer), null);
    assert.notEqual((await query<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM peon_credentials WHERE id=$1`,
      [legacy.credential.id],
    )).rows[0].revoked_at, null);
    assert.equal((await query<{ state: string }>(
      `SELECT state FROM peon_claim_credentials WHERE id=$1`,
      [credentialId],
    )).rows[0].state, "revoked");
    assert.equal(await registry.get(machine.peonId), undefined);

    const retry = await fetch(`http://127.0.0.1:${port}/api/v1/peons/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${claimBearer}`, "content-type": "application/json" },
      body: JSON.stringify({ peonId: machine.peonId, controlPort: 4570 }),
    });
    assert.equal(retry.status, 401);
    assert.equal(await registry.get(machine.peonId), undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("claim and legacy enrollment races commit one method and revoke the losing legacy bearer", async () => {
  const db = newDb();
  const adapter = db.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.peonClaimEnabled = true;
  config.peonClaimCredentialPepper = randomBytes(32).toString("base64url");
  config.peonClaimDeliveryKey = randomBytes(32).toString("base64url");
  config.peonClaimOperatorCodeKey = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  await query(`INSERT INTO users (id,email,created_at) VALUES ($1,'method-lock@test',$2)`, [ownerId, now]);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ($1,'Method lock','method-lock',$2,$3)`, [workspaceId, ownerId, now]);

  const claimWinner = identity();
  const racedLegacy = await mintCredential(workspaceId, "raced legacy", ownerId);
  await startClaim(
    claimStart(claimWinner, now, randomBytes(32).toString("base64url")),
    "203.0.113.91",
    now,
  );
  await assert.rejects(
    bindLegacyCredentialWithClaimLock(workspaceId, racedLegacy.credential.id, claimWinner.peonId, now + 1),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENROLLMENT_METHOD_LOCKED",
  );
  assert.notEqual((await query<{ revoked_at: number | null }>(
    `SELECT revoked_at FROM peon_credentials WHERE id=$1`,
    [racedLegacy.credential.id],
  )).rows[0].revoked_at, null);

  const legacyWinner = identity();
  const legacy = await mintCredential(workspaceId, "legacy winner", ownerId);
  assert.equal(await bindLegacyCredentialWithClaimLock(workspaceId, legacy.credential.id, legacyWinner.peonId, now + 10), true);
  await assert.rejects(
    startClaim(
      claimStart(legacyWinner, now + 20, randomBytes(32).toString("base64url")),
      "203.0.113.92",
      now + 20,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENROLLMENT_METHOD_LOCKED",
  );
  assert.equal((await query(
    `SELECT 1 FROM peon_claims WHERE peon_id=$1`,
    [legacyWinner.peonId],
  )).rows.length, 0);
});
