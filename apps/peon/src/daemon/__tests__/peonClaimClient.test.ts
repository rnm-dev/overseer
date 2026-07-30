import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PeonClaimClient } from "../enrollment/claimClient.js";
import { canonicalJson, PeonIdentityStore } from "../enrollment/claimIdentity.js";
import { canonicalServerOrigin, claimErrorSchema } from "../enrollment/claimProtocol.js";
import {
  EnrollmentStateStore,
  type EnrollmentState,
  type EnrollmentStatePersistence,
} from "../enrollment/claimState.js";
import { SettingsService } from "../settings/settingsService.js";
import { SettingsStore } from "../settings/settingsStore.js";

const CLAIM_ID = "7dc41f36-cf8a-4de2-a8f1-34581e223f31";
const WORKSPACE_ID = "b169219d-45f6-4f42-b78f-3fb931dac7ee";
const DELIVERY_ID = "b47f43a9-a537-4af7-abcf-ad7acfef8904";
const CREDENTIAL_ID = "6a379713-f4ca-4ca4-b4a8-9a3fbfea80d5";
const NEXT_DELIVERY_ID = "11cb934d-38dd-48fe-9e52-509f1b027d2b";
const NEXT_CREDENTIAL_ID = "95e95c93-26eb-493f-a2ac-05365186bf3a";
const BEARER = `pc1.${CREDENTIAL_ID}.${"A".repeat(43)}`;
const NEXT_BEARER = `pc1.${NEXT_CREDENTIAL_ID}.${"D".repeat(43)}`;
const SERVER_TIME = 1_785_427_200_000;

type ClaimTestBody = Record<string, unknown> & {
  attemptId: string;
  claimNonce: string;
  credentialId: string;
  display: { name: string };
  identity: { publicKey: JsonWebKey };
  peonId: string;
  proof: { issuedAt: number; requestNonce: string; signature: string };
  rotationId: string;
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function capabilities() {
  return {
    type: "claim_capabilities",
    protocol: 1,
    capability: "peon-claim-v1",
    transport: "https-short-poll",
    pollAfterMs: 2000,
    claimTtlMs: 600000,
    deliveryTtlMs: 600000,
    clockSkewMs: 120000,
    maxBodyBytes: 16384,
    serverTime: SERVER_TIME,
  };
}

function claimCreated(claimId = CLAIM_ID) {
  return {
    type: "claim_created",
    protocol: 1,
    claimId,
    operatorCode: "7K3M-9Q2R",
    operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
    state: "pending",
    createdAt: SERVER_TIME,
    expiresAt: SERVER_TIME + 600_000,
    pollAfterMs: 2000,
    serverTime: SERVER_TIME,
    replayed: false,
  };
}

function approvedStatus(overrides: Record<string, unknown> = {}) {
  return {
    type: "claim_status",
    protocol: 1,
    claimId: CLAIM_ID,
    state: "approved",
    mode: "new",
    workspaceId: WORKSPACE_ID,
    delivery: {
      deliveryId: DELIVERY_ID,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      bearer: BEARER,
      expiresAt: SERVER_TIME + 600_000,
    },
    serverTime: SERVER_TIME,
    replayed: false,
    ...overrides,
  };
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-claim-client-"));
  const statePath = path.join(root, "state", "enrollment.json");
  const identityPath = path.join(root, "config", "identity.jwk");
  const settingsPath = path.join(root, "config", "settings.json");
  const stateStore = new EnrollmentStateStore(statePath);
  const identityStore = new PeonIdentityStore(identityPath);
  const settings = new SettingsService(new SettingsStore(settingsPath));
  settings.update({ name: "Nova" });
  let armed = false;
  const pairing = {
    arm: () => {
      armed = true;
      return { phrase: "test pairing phrase", expiresAt: SERVER_TIME + 600_000 };
    },
    burn: () => { armed = false; },
    isArmed: () => armed,
  };
  return { root, statePath, identityPath, settingsPath, stateStore, identityStore, settings, pairing };
}

class FaultInjectingStateStore implements EnrollmentStatePersistence {
  constructor(
    private readonly delegate: EnrollmentStatePersistence,
    private readonly shouldFail: (next: EnrollmentState) => boolean,
  ) {}

  get(): EnrollmentState {
    return this.delegate.get();
  }

  replace(next: EnrollmentState): EnrollmentState {
    if (this.shouldFail(next)) {
      const error = new Error("simulated durable state failure") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    }
    return this.delegate.replace(next);
  }

  update(mutator: (current: EnrollmentState) => EnrollmentState): EnrollmentState {
    return this.replace(mutator(this.get()));
  }
}

function completionFetch(peonId: () => string): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-claims") return response(claimCreated());
    if (url.pathname.endsWith("/poll")) return response(approvedStatus());
    return response({
      type: "claim_completed",
      protocol: 1,
      claimId: CLAIM_ID,
      state: "completed",
      peonId: peonId() || body.peonId,
      workspaceId: WORKSPACE_ID,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      completedAt: SERVER_TIME,
      serverTime: SERVER_TIME,
      replayed: false,
    });
  };
}

function assertProof(
  body: ClaimTestBody,
  pathName: string,
  bindingNonce: string | null,
  fallbackPublicKey: JsonWebKey | null = currentPublicKey,
): void {
  const signature = body.proof.signature as string;
  const unsigned = {
    ...body,
    proof: {
      issuedAt: body.proof.issuedAt,
      requestNonce: body.proof.requestNonce,
    },
  };
  const input = {
    capability: "peon-claim-v1",
    protocol: 1,
    serverOrigin: "https://overseer.example.test",
    method: "POST",
    path: pathName,
    bindingNonce,
    body: unsigned,
  };
  const publicKey = createPublicKey({ key: body.identity?.publicKey ?? fallbackPublicKey!, format: "jwk" });
  assert.equal(
    verify(null, Buffer.from(canonicalJson(input)), publicKey, Buffer.from(signature, "base64url")),
    true,
  );
}

let currentPublicKey: JsonWebKey | null = null;

test("identity, signed claim, restart acknowledgement, and secret cleanup follow peon-claim-v1", async () => {
  const f = fixture();
  let claimNonce = "";
  let peonId = "";
  let identityPublicKey: JsonWebKey | null = null;
  let ackAuthorization = "";
  const requests: Array<{ path: string; body: ClaimTestBody }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/api/v1/peon-claims") {
      claimNonce = body.claimNonce;
      peonId = body.peonId;
      identityPublicKey = body.identity.publicKey;
      currentPublicKey = body.identity.publicKey;
      assertProof(body, url.pathname, claimNonce, identityPublicKey);
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/poll")) {
      assertProof(body, url.pathname, claimNonce, identityPublicKey);
      assert.match(String((init?.headers as Record<string, string>).Authorization), /^Bearer [A-Za-z0-9_-]{43}$/);
      return response({
        type: "claim_status",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "approved",
        mode: "new",
        workspaceId: WORKSPACE_ID,
        delivery: {
          deliveryId: DELIVERY_ID,
          credentialId: CREDENTIAL_ID,
          generation: 1,
          bearer: BEARER,
          expiresAt: SERVER_TIME + 600_000,
        },
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/ack")) {
      assertProof(body, url.pathname, claimNonce);
      ackAuthorization = String((init?.headers as Record<string, string>).Authorization);
      return response({
        type: "claim_completed",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "completed",
        peonId,
        workspaceId: WORKSPACE_ID,
        credentialId: CREDENTIAL_ID,
        generation: 1,
        completedAt: SERVER_TIME,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };

  const first = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  const created = await first.begin("https://overseer.example.test");
  assert.equal(created.operatorCode, "7K3M-9Q2R");
  await first.runOnce(); // delivery is durably persisted before acknowledgement
  assert.equal(f.stateStore.get().pendingCredential?.bearer, BEARER);
  assert.equal(f.settings.get().overseerToken, "");

  const restarted = new PeonClaimClient({
    stateStore: new EnrollmentStateStore(f.statePath),
    identityStore: new PeonIdentityStore(f.identityPath),
    settings: new SettingsService(new SettingsStore(f.settingsPath)),
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await restarted.runOnce();
  assert.equal(ackAuthorization, `Bearer ${BEARER}`);
  assert.equal(restarted.getStatus().state, "completed");
  assert.equal(f.settings.get().overseerToken, "");
  assert.equal(new SettingsStore(f.settingsPath).get().overseerToken, BEARER);

  const durableState = readFileSync(f.statePath, "utf8");
  assert.doesNotMatch(durableState, /claimToken|claimNonce|startRequest|deliveryId/);
  assert.doesNotMatch(durableState, new RegExp(BEARER.replaceAll(".", "\\.")));
  assert.equal(statSync(f.statePath).mode & 0o777, 0o600);
  assert.equal(statSync(f.identityPath).mode & 0o777, 0o600);
  const identityFile = readFileSync(f.identityPath, "utf8");
  assert.match(identityFile, /"d":/);
  assert.doesNotMatch(durableState, /"d":/);
  assert.ok(requests.length >= 3);
});

test("a lost claim_start response is retried with the same semantic body and a fresh proof after restart", async () => {
  const f = fixture();
  const starts: string[] = [];
  let failFirst = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    if (url.pathname !== "/api/v1/peon-claims") throw new Error("unexpected request");
    starts.push(String(init?.body));
    if (failFirst) {
      failFirst = false;
      throw new Error("connection reset after commit");
    }
    return response({
      type: "claim_created",
      protocol: 1,
      claimId: CLAIM_ID,
      operatorCode: "7K3M-9Q2R",
      operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
      state: "pending",
      createdAt: SERVER_TIME,
      expiresAt: SERVER_TIME + 600_000,
      pollAfterMs: 2000,
      serverTime: SERVER_TIME,
      replayed: true,
    });
  };
  const first = new PeonClaimClient({
    ...f,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await assert.rejects(first.begin("https://overseer.example.test"), /claim request transport failed/);
  assert.equal(f.stateStore.get().attempt?.phase, "starting");

  const restarted = new PeonClaimClient({
    stateStore: new EnrollmentStateStore(f.statePath),
    identityStore: new PeonIdentityStore(f.identityPath),
    settings: new SettingsService(new SettingsStore(f.settingsPath)),
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME + 60_000,
    schedule: false,
  });
  await restarted.runOnce();
  assert.equal(starts.length, 2);
  const firstBody = JSON.parse(starts[0]!) as ClaimTestBody;
  const secondBody = JSON.parse(starts[1]!) as ClaimTestBody;
  const firstSemantic = { ...firstBody };
  const secondSemantic = { ...secondBody };
  delete firstSemantic.proof;
  delete secondSemantic.proof;
  assert.deepEqual(secondSemantic, firstSemantic);
  assert.notEqual(secondBody.proof.requestNonce, firstBody.proof.requestNonce);
  assert.notEqual(secondBody.proof.issuedAt, firstBody.proof.issuedAt);
  assert.match(f.stateStore.get().attempt?.requestHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal("proof" in (f.stateStore.get().attempt?.startSemantic ?? {}), false);
  assert.equal(restarted.getStatus().state, "polling");
});

test("unsupported capability selects durable legacy mode, but transport failure never downgrades", async () => {
  const unsupported = fixture();
  const legacy = new PeonClaimClient({
    stateStore: unsupported.stateStore,
    identityStore: unsupported.identityStore,
    settings: unsupported.settings,
    pairing: unsupported.pairing,
    fetch: async () => new Response("", { status: 404 }),
    now: () => SERVER_TIME,
    schedule: false,
  });
  const result = await legacy.begin("https://overseer.example.test");
  assert.equal(result.mode, "legacy");
  assert.ok(result.legacyPhrase);
  assert.equal(legacy.legacyEnrollmentBlocked(), false);
  assert.equal(unsupported.stateStore.get().attempt?.mode, "legacy");

  const unavailable = fixture();
  const noDowngrade = new PeonClaimClient({
    stateStore: unavailable.stateStore,
    identityStore: unavailable.identityStore,
    settings: unavailable.settings,
    pairing: unavailable.pairing,
    fetch: async () => { throw new Error("TLS unavailable"); },
    now: () => SERVER_TIME,
    schedule: false,
  });
  await assert.rejects(noDowngrade.begin("https://overseer.example.test"), /claim capability transport failed/);
  assert.equal(unavailable.stateStore.get().attempt?.mode, "probe");
  assert.equal(unavailable.pairing.isArmed(), false);
});

test("a failed capability probe resumes the same durable attempt after restart", async () => {
  const f = fixture();
  const unavailable = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: async () => { throw new Error("temporary network failure"); },
    now: () => SERVER_TIME,
    schedule: false,
  });
  await assert.rejects(unavailable.begin("https://overseer.example.test"), /claim capability transport failed/);
  const attemptId = f.stateStore.get().attempt?.attemptId;
  assert.equal(f.stateStore.get().attempt?.mode, "probe");

  const resumed = new PeonClaimClient({
    stateStore: new EnrollmentStateStore(f.statePath),
    identityStore: new PeonIdentityStore(f.identityPath),
    settings: new SettingsService(new SettingsStore(f.settingsPath)),
    pairing: f.pairing,
    fetch: async (_input, init) => {
      if (init?.method === "GET") return response(capabilities());
      const body = JSON.parse(String(init?.body)) as ClaimTestBody;
      assert.equal(body.attemptId, attemptId);
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    },
    now: () => SERVER_TIME,
    schedule: false,
  });
  resumed.start();
  await resumed.runOnce();
  resumed.stop();
  assert.equal(resumed.getStatus().state, "polling");
  assert.equal(new EnrollmentStateStore(f.statePath).get().attempt?.attemptId, attemptId);
});

test("claim origins are canonical and plaintext is limited to literal loopback", () => {
  assert.equal(canonicalServerOrigin("https://OVERSEER.Example.Test/"), "https://overseer.example.test");
  assert.equal(canonicalServerOrigin("https://overseer.example.test:443"), "https://overseer.example.test");
  assert.equal(canonicalServerOrigin("http://127.0.0.1:4580/"), "http://127.0.0.1:4580");
  assert.equal(canonicalServerOrigin("http://[::1]:4580"), "http://[::1]:4580");
  for (const invalid of [
    "http://overseer.example.test",
    "https://user:secret@overseer.example.test",
    "https://overseer.example.test/api",
    "https://overseer.example.test?claim=1",
    "https://overseer.example.test/#fragment",
  ]) {
    assert.throws(() => canonicalServerOrigin(invalid));
  }
});

test("redirects and malformed capability responses never select legacy mode", async () => {
  for (const fetchImpl of [
    async () => new Response("", { status: 302, headers: { Location: "https://other.example.test" } }),
    async () => response({ ...capabilities(), unexpected: true }),
    async () => new Response("<html>proxy error</html>", { status: 502 }),
  ] satisfies Array<typeof fetch>) {
    const f = fixture();
    const client = new PeonClaimClient({
      stateStore: f.stateStore,
      identityStore: f.identityStore,
      settings: f.settings,
      pairing: f.pairing,
      fetch: fetchImpl,
      now: () => SERVER_TIME,
      schedule: false,
    });
    await assert.rejects(client.begin("https://overseer.example.test"));
    assert.notEqual(f.stateStore.get().attempt?.mode, "legacy");
    assert.equal(f.pairing.isArmed(), false);
  }
});

test("a claim response from a different operator origin is rejected before polling", async () => {
  const f = fixture();
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: async (input, init) => {
      if (init?.method === "GET") return response(capabilities());
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://attacker.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    },
    now: () => SERVER_TIME,
    schedule: false,
  });
  await assert.rejects(client.begin("https://overseer.example.test"), /operator URL/);
  assert.equal(client.getStatus().operatorUrl, undefined);
  assert.equal(f.settings.get().overseerToken, "");
});

test("CLOCK_SKEW refreshes the proof and terminal expiry erases claim secrets", async () => {
  const f = fixture();
  const startProofs: Array<{ issuedAt: number; requestNonce: string }> = [];
  let starts = 0;
  const correctedTime = SERVER_TIME + 90_000;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-claims") {
      starts += 1;
      startProofs.push(body.proof);
      if (starts === 1) {
        return response({
          type: "claim_error",
          protocol: 1,
          code: "CLOCK_SKEW",
          message: "request timestamp was outside the accepted window",
          serverTime: correctedTime,
        }, 401);
      }
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: correctedTime,
        expiresAt: correctedTime + 600_000,
        pollAfterMs: 2000,
        serverTime: correctedTime,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/poll")) {
      return response({
        type: "claim_status",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "expired",
        code: "CLAIM_EXPIRED",
        serverTime: correctedTime + 600_001,
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await assert.rejects(client.begin("https://overseer.example.test"), /claim request failed/);
  await client.runOnce();
  assert.equal(startProofs[0]?.issuedAt, SERVER_TIME);
  assert.equal(startProofs[1]?.issuedAt, correctedTime);
  assert.notEqual(startProofs[0]?.requestNonce, startProofs[1]?.requestNonce);
  await client.runOnce();
  assert.equal(client.getStatus().state, "expired");
  const durable = readFileSync(f.statePath, "utf8");
  assert.doesNotMatch(durable, /claimToken|claimNonce|startRequest|operatorCode/);
});

test("rotation persists the next bearer before ack and atomically generation-replaces the active credential", async () => {
  const f = fixture();
  const identity = f.identityStore.ensure("f4de920f-e33e-4cf5-97d0-3a75e9266090");
  f.settings.update({
    peonId: identity.peonId,
    overseerUrl: "https://overseer.example.test",
    overseerToken: BEARER,
  });
  f.stateStore.replace({
    version: 1,
    identity: {
      peonId: identity.peonId,
      identityKeyId: identity.identityKeyId,
      publicKey: identity.publicKey,
    },
    credential: {
      serverOrigin: "https://overseer.example.test",
      peonId: identity.peonId,
      identityKeyId: identity.identityKeyId,
      workspaceId: WORKSPACE_ID,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      state: "active",
    },
  });
  let rotationId = "";
  let ackBearer = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-credentials/rotations") {
      rotationId = body.rotationId;
      return response({
        type: "credential_rotation_delivery",
        protocol: 1,
        rotationId,
        state: "pending_ack",
        peonId: identity.peonId,
        previousCredentialId: CREDENTIAL_ID,
        previousGeneration: 1,
        delivery: {
          deliveryId: NEXT_DELIVERY_ID,
          credentialId: NEXT_CREDENTIAL_ID,
          generation: 2,
          bearer: NEXT_BEARER,
          expiresAt: SERVER_TIME + 600_000,
        },
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/ack")) {
      ackBearer = String((init?.headers as Record<string, string>).Authorization);
      return response({
        type: "credential_rotation_completed",
        protocol: 1,
        rotationId,
        state: "completed",
        peonId: identity.peonId,
        credentialId: NEXT_CREDENTIAL_ID,
        generation: 2,
        previousCredentialId: CREDENTIAL_ID,
        oldSocketGraceEndsAt: SERVER_TIME + 300_000,
        completedAt: SERVER_TIME,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.rotate();
  assert.equal(f.stateStore.get().pendingCredential?.bearer, NEXT_BEARER);
  assert.equal(f.settings.get().overseerToken, BEARER);
  client.recordCredentialRejection(BEARER, "CREDENTIAL_RETIRED");
  assert.equal(f.settings.get().overseerToken, "");
  assert.equal(f.stateStore.get().pendingCredential?.bearer, NEXT_BEARER);
  assert.equal(f.stateStore.get().rotation?.phase, "acknowledging");
  await client.runOnce();
  assert.equal(ackBearer, `Bearer ${NEXT_BEARER}`);
  assert.equal(f.settings.get().overseerToken, NEXT_BEARER);
  assert.equal(f.stateStore.get().credential?.generation, 2);
  assert.equal(f.stateStore.get().rotation, undefined);
  assert.doesNotMatch(readFileSync(f.statePath, "utf8"), new RegExp(BEARER.replaceAll(".", "\\.")));
});

test("only an explicit terminal rejection of the currently installed bearer erases it", () => {
  const f = fixture();
  const identity = f.identityStore.ensure("f4de920f-e33e-4cf5-97d0-3a75e9266090");
  f.settings.update({
    peonId: identity.peonId,
    overseerUrl: "https://overseer.example.test",
    overseerToken: BEARER,
  });
  f.stateStore.replace({
    version: 1,
    identity: {
      peonId: identity.peonId,
      identityKeyId: identity.identityKeyId,
      publicKey: identity.publicKey,
    },
    credential: {
      serverOrigin: "https://overseer.example.test",
      peonId: identity.peonId,
      identityKeyId: identity.identityKeyId,
      workspaceId: WORKSPACE_ID,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      state: "active",
    },
  });
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    schedule: false,
  });
  client.recordCredentialRejection("stale-bearer", "CREDENTIAL_REVOKED");
  client.recordCredentialRejection(BEARER, "UNAUTHENTICATED");
  assert.equal(f.settings.get().overseerToken, BEARER);
  client.recordCredentialRejection(BEARER, "CREDENTIAL_RETIRED");
  assert.equal(f.settings.get().overseerToken, "");
  assert.equal(f.stateStore.get().credential?.state, "revoked");
});

test("lost claim ACK is reconciled after restart with a fresh proof and the same semantic ACK", async () => {
  const f = fixture();
  let claimNonce = "";
  let identityPublicKey: JsonWebKey | null = null;
  let peonId = "";
  let ackCalls = 0;
  const acknowledgements: ClaimTestBody[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-claims") {
      claimNonce = body.claimNonce;
      identityPublicKey = body.identity.publicKey;
      peonId = body.peonId;
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/poll")) {
      return response({
        type: "claim_status",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "approved",
        mode: "new",
        workspaceId: WORKSPACE_ID,
        delivery: {
          deliveryId: DELIVERY_ID,
          credentialId: CREDENTIAL_ID,
          generation: 1,
          bearer: BEARER,
          expiresAt: SERVER_TIME + 600_000,
        },
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/ack")) {
      assertProof(body, url.pathname, claimNonce, identityPublicKey);
      acknowledgements.push(body);
      ackCalls += 1;
      if (ackCalls === 1) throw new Error("connection lost after ACK commit");
      return response({
        type: "claim_completed",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "completed",
        peonId,
        workspaceId: WORKSPACE_ID,
        credentialId: CREDENTIAL_ID,
        generation: 1,
        completedAt: SERVER_TIME,
        serverTime: SERVER_TIME + 60_000,
        replayed: true,
      });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const first = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await first.begin("https://overseer.example.test");
  await first.runOnce();
  await assert.rejects(first.runOnce(), /claim request transport failed/);
  assert.equal(f.stateStore.get().pendingCredential?.bearer, BEARER);

  const restarted = new PeonClaimClient({
    stateStore: new EnrollmentStateStore(f.statePath),
    identityStore: new PeonIdentityStore(f.identityPath),
    settings: new SettingsService(new SettingsStore(f.settingsPath)),
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME + 60_000,
    schedule: false,
  });
  await restarted.runOnce();
  const semantics = acknowledgements.map((body) => {
    const semantic = { ...body };
    delete semantic.proof;
    return semantic;
  });
  assert.deepEqual(semantics[1], semantics[0]);
  assert.notEqual(acknowledgements[1]?.proof.requestNonce, acknowledgements[0]?.proof.requestNonce);
  assert.notEqual(acknowledgements[1]?.proof.issuedAt, acknowledgements[0]?.proof.issuedAt);
  assert.equal(restarted.getStatus().state, "completed");
});

test("terminal cancel result erases local claim authentication material and exposes no secret", async () => {
  const f = fixture();
  let claimNonce = "";
  let identityPublicKey: JsonWebKey | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-claims") {
      claimNonce = body.claimNonce;
      identityPublicKey = body.identity.publicKey;
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    assert.equal(url.pathname, `/api/v1/peon-claims/${CLAIM_ID}/cancel`);
    assertProof(body, url.pathname, claimNonce, identityPublicKey);
    return response({
      type: "claim_cancel_result",
      protocol: 1,
      claimId: CLAIM_ID,
      state: "cancelled",
      code: "CLAIM_CANCELLED",
      changed: true,
      terminalAt: SERVER_TIME,
      serverTime: SERVER_TIME,
    });
  };
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.begin("https://overseer.example.test");
  const status = await client.cancel();
  assert.equal(status.state, "cancelled");
  assert.doesNotMatch(JSON.stringify(status), /7K3M-9Q2R|claimToken|claimNonce|pc1\./);
  assert.doesNotMatch(readFileSync(f.statePath, "utf8"), /7K3M-9Q2R|claimToken|claimNonce|startSemantic/);
});

test("ambiguous cancel keeps the persisted candidate until fresh ACK proves it revoked", async () => {
  const f = fixture();
  let claimNonce = "";
  let peonId = "";
  let identityPublicKey: JsonWebKey | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-claims") {
      claimNonce = body.claimNonce;
      peonId = body.peonId;
      identityPublicKey = body.identity.publicKey;
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/poll")) {
      return response({
        type: "claim_status",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "approved",
        mode: "new",
        workspaceId: WORKSPACE_ID,
        delivery: {
          deliveryId: DELIVERY_ID,
          credentialId: CREDENTIAL_ID,
          generation: 1,
          bearer: BEARER,
          expiresAt: SERVER_TIME + 600_000,
        },
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/cancel")) {
      assertProof(body, url.pathname, claimNonce, identityPublicKey);
      return response({
        type: "claim_error",
        protocol: 1,
        code: "UNAUTHENTICATED",
        message: "claim authentication failed",
        serverTime: SERVER_TIME,
      }, 401);
    }
    if (url.pathname.endsWith("/ack")) {
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${BEARER}`);
      assert.equal(body.credentialId, CREDENTIAL_ID);
      assert.equal(peonId.length > 0, true);
      return response({
        type: "claim_error",
        protocol: 1,
        code: "CREDENTIAL_REVOKED",
        message: "candidate credential was revoked by claim cancellation",
        serverTime: SERVER_TIME,
        state: "cancelled",
        claimId: CLAIM_ID,
      }, 401);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.begin("https://overseer.example.test");
  await client.runOnce();
  const afterCancel = await client.cancel();
  assert.equal(afterCancel.state, "reconciling");
  assert.equal(f.stateStore.get().pendingCredential?.bearer, BEARER);
  assert.doesNotMatch(JSON.stringify(afterCancel), /pc1\./);
  await client.runOnce();
  assert.equal(client.getStatus().state, "cancelled");
  assert.equal(f.stateStore.get().pendingCredential, undefined);
  assert.equal(f.settings.get().overseerToken, "");
});

test("CLAIM_NOT_FOUND retains the candidate until authenticated control hello confirms it active", async () => {
  const f = fixture();
  let peonId = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET") return response(capabilities());
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    if (url.pathname === "/api/v1/peon-claims") {
      peonId = body.peonId;
      return response({
        type: "claim_created",
        protocol: 1,
        claimId: CLAIM_ID,
        operatorCode: "7K3M-9Q2R",
        operatorUrl: "https://overseer.example.test/claim/7K3M-9Q2R",
        state: "pending",
        createdAt: SERVER_TIME,
        expiresAt: SERVER_TIME + 600_000,
        pollAfterMs: 2000,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    if (url.pathname.endsWith("/poll")) {
      return response({
        type: "claim_status",
        protocol: 1,
        claimId: CLAIM_ID,
        state: "approved",
        mode: "new",
        workspaceId: WORKSPACE_ID,
        delivery: {
          deliveryId: DELIVERY_ID,
          credentialId: CREDENTIAL_ID,
          generation: 1,
          bearer: BEARER,
          expiresAt: SERVER_TIME + 600_000,
        },
        serverTime: SERVER_TIME,
        replayed: false,
      });
    }
    return response({
      type: "claim_error",
      protocol: 1,
      code: "CLAIM_NOT_FOUND",
      message: "claim acknowledgement result is no longer retained",
      serverTime: SERVER_TIME + 86_400_001,
    }, 404);
  };
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.begin("https://overseer.example.test");
  await client.runOnce();
  await client.runOnce();
  assert.equal(client.getStatus().state, "reconciling");
  assert.deepEqual(client.getSocketCredentialOverride(), {
    overseerUrl: "https://overseer.example.test",
    overseerToken: BEARER,
    peonId,
  });
  assert.equal(client.confirmCandidateFromSocket("wrong", peonId), false);
  assert.equal(client.confirmCandidateFromSocket(BEARER, peonId), true);
  assert.equal(client.getStatus().state, "completed");
  assert.equal(f.settings.get().overseerToken, BEARER);
  assert.equal(client.getSocketCredentialOverride(), null);
});

test("rotation start survives response loss with fresh proof and one durable semantic hash", async () => {
  const f = fixture();
  const identity = f.identityStore.ensure("f4de920f-e33e-4cf5-97d0-3a75e9266090");
  f.settings.update({
    peonId: identity.peonId,
    overseerUrl: "https://overseer.example.test",
    overseerToken: BEARER,
  });
  f.stateStore.replace({
    version: 1,
    identity: {
      peonId: identity.peonId,
      identityKeyId: identity.identityKeyId,
      publicKey: identity.publicKey,
    },
    credential: {
      serverOrigin: "https://overseer.example.test",
      peonId: identity.peonId,
      identityKeyId: identity.identityKeyId,
      workspaceId: WORKSPACE_ID,
      credentialId: CREDENTIAL_ID,
      generation: 1,
      state: "active",
    },
  });
  const starts: ClaimTestBody[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as ClaimTestBody;
    starts.push(body);
    if (starts.length === 1) throw new Error("rotation response lost after commit");
    return response({
      type: "credential_rotation_delivery",
      protocol: 1,
      rotationId: body.rotationId,
      state: "pending_ack",
      peonId: identity.peonId,
      previousCredentialId: CREDENTIAL_ID,
      previousGeneration: 1,
      delivery: {
        deliveryId: NEXT_DELIVERY_ID,
        credentialId: NEXT_CREDENTIAL_ID,
        generation: 2,
        bearer: NEXT_BEARER,
        expiresAt: SERVER_TIME + 600_000,
      },
      serverTime: SERVER_TIME + 60_000,
      replayed: true,
    });
  };
  const first = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });
  await assert.rejects(first.rotate(), /claim request transport failed/);
  const restarted = new PeonClaimClient({
    stateStore: new EnrollmentStateStore(f.statePath),
    identityStore: new PeonIdentityStore(f.identityPath),
    settings: new SettingsService(new SettingsStore(f.settingsPath)),
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME + 60_000,
    schedule: false,
  });
  await restarted.runOnce();
  const semantics = starts.map((body) => {
    const semantic = { ...body };
    delete semantic.proof;
    return semantic;
  });
  assert.deepEqual(semantics[1], semantics[0]);
  assert.notEqual(starts[1]?.proof.requestNonce, starts[0]?.proof.requestNonce);
  assert.notEqual(starts[1]?.proof.issuedAt, starts[0]?.proof.issuedAt);
  assert.match(new EnrollmentStateStore(f.statePath).get().rotation?.requestHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(new EnrollmentStateStore(f.statePath).get().pendingCredential?.bearer, NEXT_BEARER);
});

test("cross-claim status and mismatched bearer delivery park without applying remote lifecycle state", async () => {
  const cases = [
    {
      name: "cross-claim terminal",
      poll: {
        type: "claim_status",
        protocol: 1,
        claimId: "f02d0ce2-df3b-4e83-8da9-846bd17b5511",
        state: "denied",
        code: "CLAIM_DENIED",
        serverTime: SERVER_TIME,
      },
    },
    {
      name: "mismatched bearer credential id",
      poll: approvedStatus({
        delivery: {
          deliveryId: DELIVERY_ID,
          credentialId: CREDENTIAL_ID,
          generation: 1,
          bearer: `pc1.${NEXT_CREDENTIAL_ID}.${"D".repeat(43)}`,
          expiresAt: SERVER_TIME + 600_000,
        },
      }),
    },
    {
      name: "new enrollment with a later generation",
      poll: approvedStatus({
        delivery: {
          deliveryId: DELIVERY_ID,
          credentialId: CREDENTIAL_ID,
          generation: 2,
          bearer: BEARER,
          expiresAt: SERVER_TIME + 600_000,
        },
      }),
    },
  ];
  for (const scenario of cases) {
    const f = fixture();
    const client = new PeonClaimClient({
      stateStore: f.stateStore,
      identityStore: f.identityStore,
      settings: f.settings,
      pairing: f.pairing,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "GET") return response(capabilities());
        if (url.pathname === "/api/v1/peon-claims") return response(claimCreated());
        return response(scenario.poll);
      },
      now: () => SERVER_TIME,
      schedule: false,
    });
    await client.begin("https://overseer.example.test");
    await assert.rejects(client.runOnce(), /claim status|credential delivery|credential generation/);
    const state = f.stateStore.get();
    assert.equal(state.attempt?.phase, "parked", scenario.name);
    assert.equal(state.attempt?.claimId, CLAIM_ID, scenario.name);
    assert.equal(state.attempt?.terminalState, undefined, scenario.name);
    assert.equal(state.pendingCredential, undefined, scenario.name);
  }
});

test("cross-claim completion cannot install or erase the recoverable candidate", async () => {
  const f = fixture();
  let peonId = "";
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "GET") return response(capabilities());
      const body = JSON.parse(String(init?.body)) as ClaimTestBody;
      if (url.pathname === "/api/v1/peon-claims") {
        peonId = body.peonId;
        return response(claimCreated());
      }
      if (url.pathname.endsWith("/poll")) return response(approvedStatus());
      return response({
        type: "claim_completed",
        protocol: 1,
        claimId: "f02d0ce2-df3b-4e83-8da9-846bd17b5511",
        state: "completed",
        peonId,
        workspaceId: WORKSPACE_ID,
        credentialId: CREDENTIAL_ID,
        generation: 1,
        completedAt: SERVER_TIME,
        serverTime: SERVER_TIME,
        replayed: false,
      });
    },
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.begin("https://overseer.example.test");
  await client.runOnce();
  await assert.rejects(client.runOnce(), /completion did not match/);
  assert.equal(f.stateStore.get().attempt?.phase, "parked");
  assert.equal(f.stateStore.get().pendingCredential?.bearer, BEARER);
  assert.equal(f.settings.get().overseerToken, "");
});

test("a stable error correlated to another claim cannot drive local terminal cleanup", async () => {
  const f = fixture();
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "GET") return response(capabilities());
      if (url.pathname === "/api/v1/peon-claims") return response(claimCreated());
      return response({
        type: "claim_error",
        protocol: 1,
        code: "CLAIM_DENIED",
        message: "claim was denied",
        serverTime: SERVER_TIME,
        state: "denied",
        claimId: "f02d0ce2-df3b-4e83-8da9-846bd17b5511",
      }, 409);
    },
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.begin("https://overseer.example.test");
  await assert.rejects(client.runOnce(), /claim error did not match/);
  assert.equal(f.stateStore.get().attempt?.phase, "parked");
  assert.equal(f.stateStore.get().attempt?.claimId, CLAIM_ID);
  assert.equal(f.stateStore.get().attempt?.terminalState, undefined);
});

test("cross-rotation delivery, completion, and bearer bindings cannot mutate credential state", async () => {
  for (const failure of ["delivery-id", "delivery-bearer", "completion-id"] as const) {
    const f = fixture();
    const identity = f.identityStore.ensure("f4de920f-e33e-4cf5-97d0-3a75e9266090");
    f.settings.update({
      peonId: identity.peonId,
      overseerUrl: "https://overseer.example.test",
      overseerToken: BEARER,
    });
    f.stateStore.replace({
      version: 1,
      identity: {
        peonId: identity.peonId,
        identityKeyId: identity.identityKeyId,
        publicKey: identity.publicKey,
      },
      credential: {
        serverOrigin: "https://overseer.example.test",
        peonId: identity.peonId,
        identityKeyId: identity.identityKeyId,
        workspaceId: WORKSPACE_ID,
        credentialId: CREDENTIAL_ID,
        generation: 1,
        state: "active",
      },
    });
    let rotationId = "";
    const client = new PeonClaimClient({
      stateStore: f.stateStore,
      identityStore: f.identityStore,
      settings: f.settings,
      pairing: f.pairing,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = JSON.parse(String(init?.body)) as ClaimTestBody;
        if (url.pathname === "/api/v1/peon-credentials/rotations") {
          rotationId = body.rotationId;
          return response({
            type: "credential_rotation_delivery",
            protocol: 1,
            rotationId: failure === "delivery-id"
              ? "cf682e09-b7f8-4a75-83cc-3174227331db"
              : rotationId,
            state: "pending_ack",
            peonId: identity.peonId,
            previousCredentialId: CREDENTIAL_ID,
            previousGeneration: 1,
            delivery: {
              deliveryId: NEXT_DELIVERY_ID,
              credentialId: NEXT_CREDENTIAL_ID,
              generation: 2,
              bearer: failure === "delivery-bearer"
                ? `pc1.${CREDENTIAL_ID}.${"A".repeat(43)}`
                : NEXT_BEARER,
              expiresAt: SERVER_TIME + 600_000,
            },
            serverTime: SERVER_TIME,
            replayed: false,
          });
        }
        return response({
          type: "credential_rotation_completed",
          protocol: 1,
          rotationId: "cf682e09-b7f8-4a75-83cc-3174227331db",
          state: "completed",
          peonId: identity.peonId,
          credentialId: NEXT_CREDENTIAL_ID,
          generation: 2,
          previousCredentialId: CREDENTIAL_ID,
          oldSocketGraceEndsAt: SERVER_TIME + 300_000,
          completedAt: SERVER_TIME,
          serverTime: SERVER_TIME,
          replayed: false,
        });
      },
      now: () => SERVER_TIME,
      schedule: false,
    });
    if (failure === "completion-id") {
      await client.rotate();
      await assert.rejects(client.runOnce(), /completion did not match/);
      assert.equal(f.stateStore.get().pendingCredential?.bearer, NEXT_BEARER);
    } else {
      await assert.rejects(client.rotate(), /rotation delivery|credential delivery/);
      assert.equal(f.stateStore.get().pendingCredential, undefined);
    }
    assert.equal(f.stateStore.get().rotation?.phase, "parked");
    assert.equal(f.settings.get().overseerToken, BEARER);
  }
});

test("runtime rejects unknown protocol codes and bounds display names by Unicode scalar value", async () => {
  assert.equal(claimErrorSchema.safeParse({
    type: "claim_error",
    protocol: 1,
    code: "NOT_IN_FROZEN_CONTRACT",
    message: "must not become branchable",
    serverTime: SERVER_TIME,
  }).success, false);

  const f = fixture();
  f.settings.update({ name: `${"😀".repeat(119)}e\u0301x` });
  let sentName = "";
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: async (_input, init) => {
      if (init?.method === "GET") return response(capabilities());
      const body = JSON.parse(String(init?.body)) as ClaimTestBody;
      sentName = body.display.name;
      return response(claimCreated());
    },
    now: () => SERVER_TIME,
    schedule: false,
  });
  await client.begin("https://overseer.example.test");
  assert.equal([...sentName].length, 120);
  assert.equal(sentName, `${"😀".repeat(119)}e`);
});

test("stable permanent errors park without rearming a timer; retry classes remain scheduled", async () => {
  const permanent = fixture();
  const permanentSchedules: number[] = [];
  const parked = new PeonClaimClient({
    stateStore: permanent.stateStore,
    identityStore: permanent.identityStore,
    settings: permanent.settings,
    pairing: permanent.pairing,
    fetch: async () => response({
      type: "claim_error",
      protocol: 1,
      code: "BAD_SIGNATURE",
      message: "identity proof was invalid",
      serverTime: SERVER_TIME,
    }, 401),
    now: () => SERVER_TIME,
    onTimerScheduled: (delay) => permanentSchedules.push(delay),
  });
  parked.start();
  await assert.rejects(parked.begin("https://overseer.example.test"));
  assert.equal(parked.getStatus().state, "parked");
  assert.equal(permanent.stateStore.get().attempt?.retryAt, undefined);
  assert.deepEqual(permanentSchedules, []);
  assert.equal(parked.resumeParked().state, "probing");
  assert.deepEqual(permanentSchedules, [0]);
  parked.stop();

  for (const scenario of [
    { name: "transport", fetch: async () => { throw new Error("offline"); } },
    {
      name: "server",
      fetch: async () => response({
        type: "claim_error",
        protocol: 1,
        code: "INTERNAL",
        message: "temporary service failure",
        serverTime: SERVER_TIME,
      }, 503),
    },
    {
      name: "rate-limit",
      fetch: async () => response({
        type: "claim_error",
        protocol: 1,
        code: "RATE_LIMITED",
        message: "slow down",
        serverTime: SERVER_TIME,
        retryAfterMs: 4000,
      }, 429),
    },
    {
      name: "persist",
      fetch: async () => response({
        type: "claim_error",
        protocol: 1,
        code: "PERSIST_FAILED",
        message: "temporary persistence failure",
        serverTime: SERVER_TIME,
      }, 503),
    },
  ]) {
    const f = fixture();
    const schedules: number[] = [];
    const retrying = new PeonClaimClient({
      stateStore: f.stateStore,
      identityStore: f.identityStore,
      settings: f.settings,
      pairing: f.pairing,
      fetch: scenario.fetch,
      now: () => SERVER_TIME,
      onTimerScheduled: (delay) => schedules.push(delay),
    });
    retrying.start();
    await assert.rejects(retrying.begin("https://overseer.example.test"));
    assert.notEqual(retrying.getStatus().state, "parked", scenario.name);
    assert.equal(schedules.length, 1, scenario.name);
    retrying.stop();
  }
});

test("credential handoff retains the recoverable candidate until active settings are durably committed", async () => {
  const f = fixture();
  let peonId = "";
  const failingSettings = {
    get: () => f.settings.get(),
    update: (patch: Parameters<typeof f.settings.update>[0]) => {
      if (patch.overseerToken === BEARER) {
        const error = new Error("simulated active settings failure") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      }
      const updated = f.settings.update(patch);
      peonId = updated.peonId;
      return updated;
    },
  };
  const client = new PeonClaimClient({
    stateStore: f.stateStore,
    identityStore: f.identityStore,
    settings: failingSettings,
    pairing: f.pairing,
    fetch: completionFetch(() => peonId),
    now: () => SERVER_TIME,
    schedule: false,
  });

  await client.begin("https://overseer.example.test");
  peonId = f.settings.get().peonId;
  await client.runOnce();
  await assert.rejects(client.runOnce(), /durably committed/);

  assert.equal(f.settings.get().overseerToken, "");
  assert.equal(new EnrollmentStateStore(f.statePath).get().pendingCredential?.bearer, BEARER);
  assert.equal(f.stateStore.get().attempt?.lastErrorCode, "PERSIST_FAILED");
});

test("a crash after active settings commit but before candidate cleanup recovers by replaying ACK", async () => {
  const f = fixture();
  let peonId = "";
  let failCleanup = true;
  const faultingStore = new FaultInjectingStateStore(
    f.stateStore,
    (next) => failCleanup
      && next.pendingCredential === undefined
      && next.credential?.state === "active",
  );
  const fetchImpl = completionFetch(() => peonId);
  const client = new PeonClaimClient({
    stateStore: faultingStore,
    identityStore: f.identityStore,
    settings: f.settings,
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME,
    schedule: false,
  });

  await client.begin("https://overseer.example.test");
  peonId = f.settings.get().peonId;
  await client.runOnce();
  await assert.rejects(client.runOnce(), /simulated durable state failure/);

  assert.equal(new SettingsStore(f.settingsPath).get().overseerToken, BEARER);
  assert.equal(new EnrollmentStateStore(f.statePath).get().pendingCredential?.bearer, BEARER);
  failCleanup = false;

  const restarted = new PeonClaimClient({
    stateStore: new EnrollmentStateStore(f.statePath),
    identityStore: new PeonIdentityStore(f.identityPath),
    settings: new SettingsService(new SettingsStore(f.settingsPath)),
    pairing: f.pairing,
    fetch: fetchImpl,
    now: () => SERVER_TIME + 1_000,
    schedule: false,
  });
  await restarted.runOnce();

  assert.equal(restarted.getStatus().state, "completed");
  assert.equal(new EnrollmentStateStore(f.statePath).get().pendingCredential, undefined);
  assert.equal(new SettingsStore(f.settingsPath).get().overseerToken, BEARER);
});

test("existing permissive config and state directories are repaired before private writes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-private-storage-"));
  const config = path.join(root, "config");
  const state = path.join(root, "state");
  mkdirSync(config, { mode: 0o755 });
  mkdirSync(state, { mode: 0o755 });
  chmodSync(config, 0o755);
  chmodSync(state, 0o755);
  const settingsPath = path.join(config, "settings.json");
  const identityPath = path.join(config, "identity.jwk");
  const statePath = path.join(state, "enrollment.json");

  new SettingsStore(settingsPath).update({ name: "private" });
  new PeonIdentityStore(identityPath).ensure("f4de920f-e33e-4cf5-97d0-3a75e9266090");
  new EnrollmentStateStore(statePath).replace({ version: 1 });

  assert.equal(statSync(config).mode & 0o777, 0o700);
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  assert.equal(statSync(identityPath).mode & 0o777, 0o600);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
});
