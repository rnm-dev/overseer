import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = path.resolve(import.meta.dirname, "..");
const contractDir = path.join(root, "protocol/peon-claim-v1");
const schemaText = readFileSync(path.join(contractDir, "schema.json"), "utf8");
const fixturesText = readFileSync(path.join(contractDir, "fixtures.json"), "utf8");
const securityVectorsText = readFileSync(path.join(contractDir, "security-vectors.json"), "utf8");
const schema = JSON.parse(schemaText) as { $id: string; $defs: Record<string, unknown> };
const fixtures = JSON.parse(fixturesText) as {
  contractVersion: number;
  capability: string;
  transport: string;
  limits: Record<string, number>;
  endpoints: Record<string, string>;
  frames: Record<string, { schemaRef: string; payload: Record<string, unknown> }>;
  sequences: Record<string, string[]>;
  invalidFrames: Array<{ name: string; schemaRef: string; payload: Record<string, unknown> }>;
  httpStatusByError: Record<string, number>;
  operatorHttpStatusByError: Record<string, number>;
  browserForbiddenFieldNames: string[];
};
const securityVectors = JSON.parse(securityVectorsText) as {
  proofWindowMs: number;
  requestNonceRetentionMs: number;
  ackResultRetentionMs: number;
  claimTtlMs: number;
  deliveryTtlMs: number;
  terminalMetadataRetentionMs: number;
  attemptTombstoneRetentionMs: number;
  key: {
    privateKeyPkcs8Base64: string;
    publicKeySpkiBase64: string;
    publicJwk: JsonObject;
    identityKeyId: string;
  };
  canonicalizationVector: {
    input: JsonValue;
    canonical: string;
    sha256Base64url: string;
  };
  proofVector: {
    frame: string;
    serverOrigin: string;
    method: string;
    path: string;
    bindingNonce: string;
    signedInputCanonical: string;
    signedInputSha256Base64url: string;
    signatureBase64url: string;
  };
  storageEncryptionVector: {
    algorithm: string;
    deliveryKeyVersion: number;
    deliveryKeyBase64url: string;
    nonceBits: number;
    nonceSource: string;
    nonceBase64url: string;
    nonceUniquenessScope: string[];
    retryBehavior: string;
    restartBehavior: string;
    aad: JsonObject;
    aadCanonical: string;
    plaintextUtf8: string;
    ciphertextBase64url: string;
    tagBase64url: string;
    uniqueNonceSamplesBase64url: string[];
  };
  semanticHashVectors: Record<string, {
    frame: string;
    exclude: string[];
    canonical: string;
    sha256LowerHex: string;
  }>;
  minimalLookupPolicy: Record<string, string[]>;
  forbiddenBeforeProofVerification: string[];
  goldenCases: Array<{
    name: string;
    operation: string;
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
  }>;
};

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

function validator(schemaRef: string) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${schemaRef}`);
  assert.ok(validate, `missing schema definition ${schemaRef}`);
  return validate;
}

function fieldNames(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) fieldNames(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      result.add(key);
      fieldNames(nested, result);
    }
  }
  return result;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const encoded = JSON.stringify(value);
    assert.notEqual(encoded, undefined);
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function sha256LowerHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function result(
  stableResult: string,
  httpStatus: number,
  proofVerified: boolean,
  nonceConsumed: boolean,
  deliveryDecrypted: boolean,
  mutation = "none",
  replayed = false,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stableResult,
    httpStatus,
    replayed,
    proofVerified,
    nonceConsumed,
    deliveryDecrypted,
    mutation,
    ...extra,
  };
}

function evaluateGoldenCase(operation: string, input: Record<string, unknown>): Record<string, unknown> {
  if (operation === "legacy_enroll") {
    return result(
      "ENROLLMENT_METHOD_LOCKED",
      409,
      false,
      false,
      false,
      input.legacyCredentialMinted ? "revoke_raced_legacy_credential" : "none",
    );
  }
  if (operation === "claim_ack_cancel_reconcile") {
    assert.equal(input.candidatePersisted, true);
    assert.equal(input.freshAckProof, true);
    if (input.ackResponse === "CLAIM_NOT_FOUND") {
      assert.equal(input.candidateControlHello, "authenticated_hello_ack");
      return {
        stableResult: "CREDENTIAL_ACTIVE",
        transport: "control_wss_hello_ack",
        candidateAuthenticated: true,
        mutation: "promote_persisted_candidate",
        raceWinner: "ack",
        candidateDisposition: "active",
        enrollmentConverged: true,
      };
    }
    if (input.winner === "ack") {
      return result("CLAIM_COMPLETED", 200, true, true, false, "promote_persisted_candidate", true, {
        raceWinner: "ack",
        candidateDisposition: "active",
        enrollmentConverged: true,
      });
    }
    return result("CREDENTIAL_REVOKED", 401, true, false, false, "discard_revoked_candidate", false, {
      raceWinner: "cancel",
      candidateDisposition: "discarded",
      enrollmentConverged: true,
    });
  }
  if (operation === "credential_revoke" || operation === "peon_revoke") {
    const scope = operation === "credential_revoke" ? "credential" : "peon";
    if (input.authenticated !== true) {
      return {
        stableResult: "UNAUTHENTICATED",
        httpStatus: 401,
        mutation: "none",
        auditEvent: "none",
        auditOutcome: "none",
      };
    }
    if (input.authTransport === "cookie" && input.originValid !== true) {
      return {
        stableResult: "CSRF_ORIGIN",
        httpStatus: 403,
        mutation: "none",
        auditEvent: "none",
        auditOutcome: "none",
      };
    }
    if (input.targetRelation === "unknown" || input.targetRelation === "cross_workspace") {
      return {
        stableResult: "NOT_FOUND",
        httpStatus: 404,
        mutation: "none",
        auditEvent: "none",
        auditOutcome: "none",
      };
    }
    assert.equal(input.targetRelation, "same_workspace");
    if (input.workspaceRole !== "owner") {
      return {
        stableResult: "FORBIDDEN",
        httpStatus: 403,
        mutation: "none",
        auditEvent: `${scope}.revoke_denied`,
        auditOutcome: "forbidden",
      };
    }
    if (input.targetState === "already_revoked") {
      return {
        stableResult: scope === "credential" ? "CREDENTIAL_REVOKED" : "PEON_REVOKED",
        httpStatus: 200,
        mutation: "none",
        auditEvent: `${scope}.revoked`,
        auditOutcome: "already_revoked",
      };
    }
    return {
      stableResult: scope === "credential" ? "CREDENTIAL_REVOKED" : "PEON_REVOKED",
      httpStatus: 200,
      mutation: scope === "credential"
        ? "revoke_one_credential_and_evict_sockets"
        : "revoke_peon_credentials_claims_rotations_and_sockets",
      auditEvent: `${scope}.revoked`,
      auditOutcome: "revoked",
    };
  }
  if (input.authState === "invalid") {
    return result("UNAUTHENTICATED", 401, false, false, false);
  }
  if (Math.abs(input.proofAgeMs as number) > securityVectors.proofWindowMs) {
    return result("CLOCK_SKEW", 401, false, false, false);
  }
  if (!input.signatureValid) {
    return result("BAD_SIGNATURE", 401, false, false, false);
  }
  if (input.authState === "revoked") {
    return result("CREDENTIAL_REVOKED", 401, true, false, false);
  }
  if (input.authState === "retired") {
    return result("CREDENTIAL_RETIRED", 401, true, false, false);
  }
  const nonceSeen = input.nonceState === "seen"
    || (
      input.nonceState === "derive_from_age"
      && input.noncePreviouslySeen === true
      && (input.nonceAgeMs as number) <= securityVectors.requestNonceRetentionMs
    );
  if (nonceSeen) {
    return result("REQUEST_REPLAYED", 409, true, false, false);
  }

  const admitted = (
    stableResult: string,
    httpStatus: number,
    mutation = "none",
    replayed = false,
    extra: Record<string, unknown> = {},
  ) => result(stableResult, httpStatus, true, true, false, mutation, replayed, extra);

  if (operation === "claim_start" && input.enrollmentLease === "legacy") {
    return admitted("ENROLLMENT_METHOD_LOCKED", 409);
  }
  if (operation === "claim_poll") {
    assert.equal(input.claimState, "approved");
    assert.equal(input.hasEncryptedDelivery, true);
    return result("CLAIM_APPROVED", 200, true, true, true, "mark_delivered");
  }
  if (operation === "claim_cancel") {
    if (input.claimState === "denied" || input.claimState === "expired") {
      const stable = input.claimState === "denied" ? "CLAIM_DENIED" : "CLAIM_EXPIRED";
      return admitted(stable, 200, "observe_terminal_claim", false, {
        changed: false,
        cleanup: ["claimTokenHash"],
      });
    }
    return admitted("CLAIM_CANCELLED", 200, "cancel_claim", false, {
      changed: true,
      cleanup: [
        "claimTokenHash",
        "encryptedDelivery",
        "pendingCredential",
        "operatorCodeIndex",
        "enrollmentLease",
      ],
    });
  }

  if (
    (operation === "claim_ack" || operation === "rotation_ack")
    && input.semanticRelation === "same"
    && (input.resultAgeMs as number) > securityVectors.ackResultRetentionMs
  ) {
    return admitted(operation === "claim_ack" ? "CLAIM_NOT_FOUND" : "ROTATION_EXPIRED", operation === "claim_ack" ? 404 : 410);
  }
  if (input.semanticRelation === "different") {
    const mismatch = {
      claim_start: "ATTEMPT_ID_REUSED",
      rotation_start: "ROTATION_ID_REUSED",
      claim_ack: "CLAIM_ACK_MISMATCH",
      rotation_ack: "ROTATION_ACK_MISMATCH",
    }[operation];
    assert.ok(mismatch, `no semantic mismatch result for ${operation}`);
    return admitted(mismatch, 409);
  }
  if (operation === "claim_start" && input.semanticRelation === "same" && input.claimPhase) {
    if (input.claimPhase === "pending") {
      if ((input.claimAgeMs as number) < securityVectors.claimTtlMs) {
        return admitted("CLAIM_CREATED", 201, "none", true, {
          operatorCodeMaterial: "original_sealed",
        });
      }
      return admitted("CLAIM_EXPIRED", 410, "expire_claim_and_erase_operator_code", false, {
        operatorCodeMaterial: "none",
      });
    }
    if (input.claimPhase === "approved") {
      if ((input.deliveryAgeMs as number) < securityVectors.deliveryTtlMs) {
        return admitted("CLAIM_ALREADY_ACTIVE", 409, "none", false, {
          operatorCodeMaterial: "none",
        });
      }
      return admitted("CLAIM_EXPIRED", 410, "expire_delivery_and_revoke_candidate", false, {
        operatorCodeMaterial: "none",
      });
    }
    if (input.claimPhase === "completed") {
      return admitted("CLAIM_ALREADY_ACTIVE", 409, "none", false, {
        operatorCodeMaterial: "none",
      });
    }
    if (["denied", "cancelled", "expired"].includes(input.claimPhase as string)) {
      const stable = {
        denied: "CLAIM_DENIED",
        cancelled: "CLAIM_CANCELLED",
        expired: "CLAIM_EXPIRED",
      }[input.claimPhase as string] as string;
      return admitted(stable, stable === "CLAIM_EXPIRED" ? 410 : 409, "none", false, {
        operatorCodeMaterial: "none",
      });
    }
    assert.equal(input.claimPhase, "tombstone");
    if ((input.tombstoneAgeMs as number) <= securityVectors.attemptTombstoneRetentionMs) {
      const mutation = (input.terminalAgeMs as number) > securityVectors.terminalMetadataRetentionMs
        && (input.tombstoneAgeMs as number) < securityVectors.attemptTombstoneRetentionMs
        ? "prune_terminal_metadata"
        : "none";
      return admitted("ATTEMPT_RETIRED", 410, mutation, false, {
        operatorCodeMaterial: "none",
      });
    }
    assert.equal(input.eligibility, "new_claim_allowed");
    return admitted("CLAIM_CREATED", 201, "prune_tombstone_and_create_new_claim", false, {
      operatorCodeMaterial: "new",
      oldOperatorCodeRecovered: false,
    });
  }
  if (input.semanticRelation === "same") {
    assert.equal(typeof input.priorStableResult, "string");
    if (operation === "rotation_start") {
      return result(input.priorStableResult as string, 200, true, true, true, "none", true);
    }
    return admitted(input.priorStableResult as string, operation === "claim_start" ? 201 : 200, "none", true);
  }

  const created = {
    claim_start: ["CLAIM_CREATED", 201, false, "create_claim"],
    claim_ack: ["CLAIM_COMPLETED", 200, false, "activate_claim_credential"],
    rotation_start: ["ROTATION_DELIVERY", 201, true, "create_rotation"],
    rotation_ack: ["ROTATION_COMPLETED", 200, false, "activate_rotation_generation"],
  }[operation] as [string, number, boolean, string] | undefined;
  assert.ok(created, `no new semantic result for ${operation}`);
  return result(created[0], created[1], true, true, created[2], created[3]);
}

test("vendored peon-claim-v1 golden frames validate against both the schema root and named definition", () => {
  assert.equal(schema.$id, "https://peon.local/protocol/peon-claim-v1/schema.json");
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "peon-claim-v1");
  assert.equal(fixtures.transport, "https-short-poll");
  assert.equal(fixtures.endpoints.poll, "POST /api/v1/peon-claims/:claimId/poll");
  assert.equal(fixtures.endpoints.cancel, "POST /api/v1/peon-claims/:claimId/cancel");
  assert.equal(fixtures.endpoints.rotationStatus, "POST /api/v1/peon-credentials/rotations/:rotationId/poll");
  assert.equal(
    fixtures.endpoints.revokeCredential,
    "POST /api/workspaces/:workspaceId/peons/:peonId/credentials/:credentialId/revoke",
  );
  assert.equal(
    fixtures.endpoints.revokePeon,
    "POST /api/workspaces/:workspaceId/peons/:peonId/revoke",
  );

  const validateRoot = ajv.getSchema(schema.$id);
  assert.ok(validateRoot, "missing schema root validator");
  for (const [name, frame] of Object.entries(fixtures.frames)) {
    const validate = validator(frame.schemaRef);
    assert.equal(
      validate(frame.payload),
      true,
      `${name} failed ${frame.schemaRef}: ${ajv.errorsText(validate.errors)}`,
    );
    assert.equal(
      validateRoot(frame.payload),
      true,
      `${name} failed schema root: ${ajv.errorsText(validateRoot.errors)}`,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(frame.payload), "utf8") <= fixtures.limits.maxBodyBytes);
  }
});

test("vendored peon-claim-v1 rejects golden malformed frames", () => {
  for (const invalid of fixtures.invalidFrames) {
    assert.equal(
      validator(invalid.schemaRef)(invalid.payload),
      false,
      `${invalid.name} unexpectedly satisfied ${invalid.schemaRef}`,
    );
  }
});

test("golden lifecycle sequences reference complete frames and preserve one delivery", () => {
  for (const [name, sequence] of Object.entries(fixtures.sequences)) {
    assert.ok(sequence.length > 0, `${name} must not be empty`);
    for (const frameName of sequence) assert.ok(fixtures.frames[frameName], `${name} references ${frameName}`);
  }

  const first = fixtures.frames.approvedStatus.payload;
  const replay = fixtures.frames.approvedStatusReplay.payload;
  assert.deepEqual(replay.delivery, first.delivery);
  assert.equal(replay.replayed, true);
  assert.equal(fixtures.frames.claimCreatedReplay.payload.claimId, fixtures.frames.claimCreated.payload.claimId);
  assert.equal(fixtures.frames.recoveryApprovalResult.payload.mode, "recover");
  assert.equal((fixtures.frames.recoveryApprovedStatus.payload.delivery as { generation: number }).generation, 3);
  assert.equal(fixtures.frames.recoveryCompleted.payload.generation, 3);
});

test("browser-safe fixtures exclude all forbidden claim and credential material", () => {
  for (const frameName of [
    "claimDetails",
    "approvalResult",
    "recoveryApprovalResult",
    "denialResult",
    "credentialRevocationResult",
    "peonRevocationResult",
    "credentialRevocationForbidden",
    "peonRevocationForbidden",
  ]) {
    const names = fieldNames(fixtures.frames[frameName].payload);
    for (const forbidden of fixtures.browserForbiddenFieldNames) {
      assert.equal(names.has(forbidden), false, `${frameName} exposes ${forbidden}`);
    }
  }
});

test("credential lifecycle error mappings and security bounds stay frozen", () => {
  const errorCodes = ((schema.$defs.claimError as {
    properties: { code: { enum: string[] } };
  }).properties.code.enum);
  assert.deepEqual(Object.keys(fixtures.httpStatusByError).sort(), [...errorCodes].sort());
  assert.deepEqual(
    Object.fromEntries(["ATTEMPT_ID_REUSED", "REQUEST_REPLAYED", "ENROLLMENT_METHOD_LOCKED", "CREDENTIAL_RETIRED", "ROTATION_EXPIRED"].map(
      (code) => [code, fixtures.httpStatusByError[code]],
    )),
    {
      ATTEMPT_ID_REUSED: 409,
      REQUEST_REPLAYED: 409,
      ENROLLMENT_METHOD_LOCKED: 409,
      CREDENTIAL_RETIRED: 401,
      ROTATION_EXPIRED: 410,
    },
  );
  assert.equal(fixtures.limits.claimTtlMs, 10 * 60 * 1000);
  assert.equal(fixtures.limits.deliveryTtlMs, 10 * 60 * 1000);
  assert.equal(fixtures.limits.oldSocketGraceMs, 5 * 60 * 1000);
  assert.equal(fixtures.limits.clockSkewMs, 2 * 60 * 1000);
  assert.equal(securityVectors.proofWindowMs, fixtures.limits.clockSkewMs);
  assert.equal(securityVectors.requestNonceRetentionMs, 24 * 60 * 60 * 1000);
  assert.equal(securityVectors.ackResultRetentionMs, 24 * 60 * 60 * 1000);
  assert.equal(securityVectors.claimTtlMs, fixtures.limits.claimTtlMs);
  assert.equal(securityVectors.deliveryTtlMs, fixtures.limits.deliveryTtlMs);
  assert.equal(securityVectors.terminalMetadataRetentionMs, 24 * 60 * 60 * 1000);
  assert.equal(securityVectors.attemptTombstoneRetentionMs, 7 * 24 * 60 * 60 * 1000);
  const operatorErrorCodes = ((schema.$defs.operatorError as {
    properties: { code: { enum: string[] } };
  }).properties.code.enum);
  assert.deepEqual(Object.keys(fixtures.operatorHttpStatusByError).sort(), [...operatorErrorCodes].sort());
});

test("RFC 8785, SHA-256, and Ed25519 security vectors execute byte-for-byte", () => {
  const canonical = canonicalJson(securityVectors.canonicalizationVector.input);
  assert.equal(canonical, securityVectors.canonicalizationVector.canonical);
  assert.equal(sha256Base64url(canonical), securityVectors.canonicalizationVector.sha256Base64url);

  const frame = cloneJson(fixtures.frames[securityVectors.proofVector.frame].payload) as JsonObject;
  const proof = frame.proof as JsonObject;
  assert.equal(proof.signature, securityVectors.proofVector.signatureBase64url);
  delete proof.signature;
  const signedInput = {
    capability: frame.capability,
    protocol: frame.protocol,
    serverOrigin: securityVectors.proofVector.serverOrigin,
    method: securityVectors.proofVector.method,
    path: securityVectors.proofVector.path,
    bindingNonce: securityVectors.proofVector.bindingNonce,
    body: frame,
  } as JsonObject;
  const signedCanonical = canonicalJson(signedInput);
  assert.equal(signedCanonical, securityVectors.proofVector.signedInputCanonical);
  assert.equal(sha256Base64url(signedCanonical), securityVectors.proofVector.signedInputSha256Base64url);

  const privateKey = createPrivateKey({
    key: Buffer.from(securityVectors.key.privateKeyPkcs8Base64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey({
    key: Buffer.from(securityVectors.key.publicKeySpkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  assert.deepEqual(publicKey.export({ format: "jwk" }), securityVectors.key.publicJwk);
  assert.deepEqual(createPublicKey(privateKey).export({ format: "jwk" }), securityVectors.key.publicJwk);
  assert.equal(
    `ed25519:${sha256Base64url(canonicalJson(securityVectors.key.publicJwk))}`,
    securityVectors.key.identityKeyId,
  );
  const signature = sign(null, Buffer.from(signedCanonical, "utf8"), privateKey);
  assert.equal(signature.toString("base64url"), securityVectors.proofVector.signatureBase64url);
  assert.equal(
    verify(
      null,
      Buffer.from(signedCanonical, "utf8"),
      publicKey,
      Buffer.from(securityVectors.proofVector.signatureBase64url, "base64url"),
    ),
    true,
  );
  const changedBody = cloneJson(signedInput);
  ((changedBody.body as JsonObject).display as JsonObject).name = "Changed Nova";
  assert.equal(
    verify(null, Buffer.from(canonicalJson(changedBody), "utf8"), publicKey, signature),
    false,
  );
  const changedProofNonce = cloneJson(signedInput);
  (((changedProofNonce.body as JsonObject).proof as JsonObject)).requestNonce = "changed-proof-request-nonce";
  assert.equal(
    verify(null, Buffer.from(canonicalJson(changedProofNonce), "utf8"), publicKey, signature),
    false,
  );
});

test("AES-256-GCM storage vector enforces 96-bit nonce uniqueness and stored-tuple retries", () => {
  const vector = securityVectors.storageEncryptionVector;
  assert.equal(vector.algorithm, "AES-256-GCM");
  assert.equal(vector.nonceBits, 96);
  assert.equal(vector.nonceSource, "CSPRNG");
  assert.deepEqual(vector.nonceUniquenessScope, ["deliveryKeyVersion", "nonceBase64url"]);
  assert.equal(vector.retryBehavior, "reuse_stored_tuple_without_reencryption");
  assert.equal(vector.restartBehavior, "reuse_stored_tuple_without_reencryption");
  assert.equal(canonicalJson(vector.aad), vector.aadCanonical);

  const key = Buffer.from(vector.deliveryKeyBase64url, "base64url");
  const nonce = Buffer.from(vector.nonceBase64url, "base64url");
  assert.equal(key.byteLength, 32);
  assert.equal(nonce.byteLength, 12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(vector.aadCanonical, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(vector.plaintextUtf8, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  assert.equal(ciphertext.toString("base64url"), vector.ciphertextBase64url);
  assert.equal(tag.toString("base64url"), vector.tagBase64url);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(vector.aadCanonical, "utf8"));
  decipher.setAuthTag(tag);
  assert.equal(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    vector.plaintextUtf8,
  );
  const decodedNonces = vector.uniqueNonceSamplesBase64url.map((sample) => Buffer.from(sample, "base64url"));
  assert.ok(decodedNonces.every((sample) => sample.byteLength === 12));
  assert.equal(new Set(vector.uniqueNonceSamplesBase64url.map(
    (sample) => `${vector.deliveryKeyVersion}:${sample}`,
  )).size, vector.uniqueNonceSamplesBase64url.length);
});

test("semantic idempotency hashes exclude only proof freshness and operation IDs", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(securityVectors.semanticHashVectors).map(([name, vector]) => [name, vector.exclude])),
    {
      claimStart: ["attemptId", "proof"],
      rotationStart: ["rotationId", "proof"],
      claimAck: ["proof"],
      rotationAck: ["proof"],
    },
  );
  for (const [name, vector] of Object.entries(securityVectors.semanticHashVectors)) {
    const semantic = cloneJson(fixtures.frames[vector.frame].payload) as JsonObject;
    for (const excluded of vector.exclude) delete semantic[excluded];
    const canonical = canonicalJson(semantic);
    assert.equal(canonical, vector.canonical, `${name} canonical semantic input changed`);
    assert.equal(sha256LowerHex(canonical), vector.sha256LowerHex, `${name} semantic hash changed`);

    const freshProofFrame = cloneJson(fixtures.frames[vector.frame].payload) as JsonObject;
    if (freshProofFrame.proof && typeof freshProofFrame.proof === "object") {
      freshProofFrame.proof = {
        issuedAt: 1785427320001,
        requestNonce: "fresh-proof-request-nonce",
        signature: "fresh-proof-signature",
      };
    }
    if (name === "claimStart") freshProofFrame.attemptId = "0191f9f4-8ac2-7e00-8c1a-742388f6ff41";
    if (name === "rotationStart") freshProofFrame.rotationId = "cf682e09-b7f8-4a75-83cc-3174227331db";
    for (const excluded of vector.exclude) delete freshProofFrame[excluded];
    assert.equal(sha256LowerHex(canonicalJson(freshProofFrame)), vector.sha256LowerHex);

    if (name === "claimStart") ((semantic.display as JsonObject)).name = "Changed Nova";
    else if (name === "rotationStart") semantic.currentGeneration = (semantic.currentGeneration as number) + 1;
    else semantic.generation = (semantic.generation as number) + 1;
    assert.notEqual(sha256LowerHex(canonicalJson(semantic)), vector.sha256LowerHex);
  }
});

test("pre-proof lookup is minimal and cannot read protected business or delivery material", () => {
  const forbidden = new Set(securityVectors.forbiddenBeforeProofVerification);
  assert.deepEqual(securityVectors.minimalLookupPolicy, {
    claim_start: ["peonId", "identityKeyId", "boundPublicJwk"],
    claim_poll: ["claimId", "claimTokenHash", "peonId", "identityKeyId", "publicJwk", "claimNonce", "serverOrigin"],
    claim_cancel: ["claimId", "claimTokenHash", "peonId", "identityKeyId", "publicJwk", "claimNonce", "serverOrigin"],
    claim_ack: [
      "claimId", "deliveryId", "credentialId", "credentialVerifier", "credentialState", "generation",
      "peonId", "identityKeyId", "publicJwk", "claimNonce", "serverOrigin",
    ],
    rotation_start: [
      "credentialId", "credentialVerifier", "credentialState", "generation", "peonId",
      "identityKeyId", "publicJwk", "serverOrigin",
    ],
    rotation_poll: [
      "rotationId", "credentialId", "credentialVerifier", "credentialState", "peonId",
      "identityKeyId", "publicJwk", "serverOrigin",
    ],
    rotation_ack: [
      "rotationId", "deliveryId", "credentialId", "credentialVerifier", "credentialState", "generation",
      "peonId", "identityKeyId", "publicJwk", "serverOrigin",
    ],
  });
  assert.deepEqual(securityVectors.forbiddenBeforeProofVerification, [
    "bearerCiphertext", "bearerNonce", "bearerTag", "deliveryKey", "operatorCode", "operatorActor",
    "display", "workspaceMembers", "auditPayload", "activeEnrollmentLease", "activeRotationId",
    "claimState", "rotationState", "expiresAt", "semanticHash", "stableResult", "identityWorkspaceId",
  ]);
  for (const [operation, fields] of Object.entries(securityVectors.minimalLookupPolicy)) {
    assert.ok(fields.length > 0, `${operation} must define authentication lookup fields`);
    for (const field of fields) assert.equal(forbidden.has(field), false, `${operation} reads ${field} before proof`);
  }
});

test("golden lifecycle evaluator freezes replay ordering, restart, revocation, cancel, and race results", () => {
  for (const vector of securityVectors.goldenCases) {
    assert.deepEqual(evaluateGoldenCase(vector.operation, vector.input), vector.expected, vector.name);
  }
  const names = securityVectors.goldenCases.map((vector) => vector.name).join("\n");
  for (const required of [
    "persisted proof",
    "fresh proof after proof window",
    "changed claim body",
    "same nonce",
    "seen nonce at 24-hour replay boundary",
    "pending claim just before 10-minute TTL",
    "pending claim at 10-minute TTL",
    "approved delivery just before 10-minute TTL",
    "approved delivery at 10-minute TTL",
    "terminal metadata at 24-hour boundary",
    "terminal metadata after 24-hour boundary",
    "attempt at seven-day tombstone boundary",
    "attempt after seven-day tombstone boundary",
    "bad signature",
    "claim ACK after commit and restart",
    "claim ACK persisted proof",
    "claim ACK fresh proof after proof window",
    "claim ACK result expires",
    "rotation start after commit and restart",
    "rotation start persisted proof",
    "rotation start fresh proof after proof window",
    "rotation ACK after commit and restart",
    "rotation ACK persisted proof",
    "rotation ACK fresh proof after proof window",
    "rotation ACK result expires",
    "revocation wins",
    "terminal denial",
    "cancel retry",
    "ACK wins then lost ACK",
    "ACK wins against already-authenticated cancel",
    "ACK result metadata expired",
    "cancel wins with lost response",
    "cancel wins before restart",
    "unauthenticated credential revocation",
    "unauthenticated Peon-wide revocation",
    "unknown credential revocation target",
    "cross-workspace credential revocation target",
    "unknown Peon-wide revocation target",
    "cross-workspace Peon-wide revocation target",
    "credential revocation by non-owner",
    "Peon-wide revocation by non-owner",
    "untrusted origin is CSRF denied",
    "owner credential revocation",
    "owner credential revocation repeat",
    "owner device bearer Peon-wide revocation",
    "legacy lock",
    "raced legacy credential",
  ]) {
    assert.match(names, new RegExp(required), `missing golden boundary: ${required}`);
  }
});

test("Overseer and Peon peon-claim-v1 vendors are byte-identical", () => {
  const peonDir = path.resolve(root, "../peon/protocol/peon-claim-v1");
  assert.equal(readFileSync(path.join(peonDir, "schema.json"), "utf8"), schemaText);
  assert.equal(readFileSync(path.join(peonDir, "fixtures.json"), "utf8"), fixturesText);
  assert.equal(readFileSync(path.join(peonDir, "security-vectors.json"), "utf8"), securityVectorsText);
});
