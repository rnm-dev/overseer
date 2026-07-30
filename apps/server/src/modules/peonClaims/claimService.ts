import { randomUUID } from "node:crypto";
import { config } from "../../config.js";
import type { Transaction } from "../../db.js";
import { query, transaction, transactionWithAdvisoryLock } from "../../db.js";
import {
  evictPeonConnection,
  evictPeonConnectionGeneration,
  evictPeonConnectionsBelowGeneration,
} from "../../peonConnections.js";
import {
  evictPeonTransferConnection,
  evictPeonTransferConnectionGeneration,
  evictPeonTransferConnectionsBelowGeneration,
} from "../../peonTransferConnections.js";
import {
  claimKeysConfigured,
  CLAIM_CAPABILITY,
  CLAIM_TTL_MS,
  CLOCK_SKEW_MS,
  credentialVerifier,
  DELIVERY_TTL_MS,
  identityKeyId,
  MAX_BODY_BYTES,
  mintBearer,
  NONCE_RETENTION_MS,
  OLD_SOCKET_GRACE_MS,
  openBearer,
  openOperatorCode,
  operatorCode,
  operatorCodeHash,
  parseBearer,
  POLL_AFTER_MS,
  safeEqualText,
  sealBearer,
  sealOperatorCode,
  semanticRequestHash,
  sha256Base64url,
  subjectHash,
  TERMINAL_RETENTION_MS,
  TOMBSTONE_MS,
  verifyRequestProof,
  type Proof,
  type PublicJwk,
} from "./claimCrypto.js";
import {
  ClaimServiceError,
  type ClaimCredentialRow,
  type ClaimDisplay,
  type ClaimRow,
  type DeliveryRow,
} from "./claimTypes.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_NONCE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const IDENTITY_KEY = /^ed25519:[A-Za-z0-9_-]{43}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const CLAIM_CAPACITY = 10_000;

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, UNSUPPORTED_CAPABILITY: 400, UNSUPPORTED_PROTOCOL: 400, INVALID_IDENTITY: 400,
  BAD_SIGNATURE: 401, CLOCK_SKEW: 401, UNAUTHENTICATED: 401, FORBIDDEN: 403,
  REQUEST_REPLAYED: 409, ATTEMPT_ID_REUSED: 409, ATTEMPT_RETIRED: 410, ROTATION_ID_REUSED: 409,
  CLAIM_ACK_MISMATCH: 409, ROTATION_ACK_MISMATCH: 409,
  CLAIM_NOT_FOUND: 404, CLAIM_ALREADY_ACTIVE: 409, CLAIM_ALREADY_DECIDED: 409,
  CLAIM_DENIED: 409, CLAIM_CANCELLED: 409, CLAIM_EXPIRED: 410, CLAIM_CAPACITY_EXCEEDED: 503,
  IDENTITY_KEY_MISMATCH: 409, PEON_ALREADY_CLAIMED: 409, WORKSPACE_MISMATCH: 409,
  ENROLLMENT_METHOD_LOCKED: 409, CREDENTIAL_INVALID: 401, CREDENTIAL_REVOKED: 401,
  CREDENTIAL_RETIRED: 401, CREDENTIAL_GENERATION_MISMATCH: 409,
  ROTATION_ALREADY_ACTIVE: 409, ROTATION_EXPIRED: 410, RATE_LIMITED: 429,
  PERSIST_FAILED: 503, INTERNAL: 500,
};

const SAFE_MESSAGES: Record<string, string> = {
  BAD_REQUEST: "request does not match peon-claim-v1",
  UNSUPPORTED_CAPABILITY: "peon-claim-v1 is not available",
  UNSUPPORTED_PROTOCOL: "unsupported claim protocol",
  INVALID_IDENTITY: "invalid Peon identity",
  BAD_SIGNATURE: "identity proof is invalid",
  CLOCK_SKEW: "request time is outside the allowed clock skew",
  UNAUTHENTICATED: "authentication failed",
  FORBIDDEN: "the authenticated operator is not allowed to perform this action",
  REQUEST_REPLAYED: "signed request nonce was already used",
  ATTEMPT_ID_REUSED: "attempt ID was reused with a different request",
  ATTEMPT_RETIRED: "claim attempt retention window has not elapsed",
  ROTATION_ID_REUSED: "rotation ID was reused with a different request",
  CLAIM_ACK_MISMATCH: "claim acknowledgement does not match the committed delivery",
  ROTATION_ACK_MISMATCH: "rotation acknowledgement does not match the committed delivery",
  CLAIM_NOT_FOUND: "claim was not found",
  CLAIM_ALREADY_ACTIVE: "this identity already has an active claim",
  CLAIM_ALREADY_DECIDED: "claim already has a different decision",
  CLAIM_DENIED: "claim was denied",
  CLAIM_CANCELLED: "claim was cancelled",
  CLAIM_EXPIRED: "claim expired",
  CLAIM_CAPACITY_EXCEEDED: "claim service capacity is exhausted",
  IDENTITY_KEY_MISMATCH: "Peon identity key does not match its binding",
  PEON_ALREADY_CLAIMED: "Peon identity belongs to another workspace",
  WORKSPACE_MISMATCH: "credential is bound to another workspace",
  ENROLLMENT_METHOD_LOCKED: "another enrollment method holds this identity",
  CREDENTIAL_INVALID: "credential is invalid",
  CREDENTIAL_REVOKED: "credential is revoked",
  CREDENTIAL_RETIRED: "credential is retired",
  CREDENTIAL_GENERATION_MISMATCH: "credential generation does not match",
  ROTATION_ALREADY_ACTIVE: "this Peon already has a pending rotation",
  ROTATION_EXPIRED: "credential rotation expired",
  RATE_LIMITED: "request rate limit exceeded",
  PERSIST_FAILED: "claim state could not be persisted",
  INTERNAL: "claim service failed",
};

export function claimError(code: string, extra: Record<string, unknown> = {}): ClaimServiceError {
  return new ClaimServiceError(code, STATUS[code] ?? 500, SAFE_MESSAGES[code] ?? SAFE_MESSAGES.INTERNAL, extra);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validProof(value: unknown): value is Proof {
  const proof = record(value);
  return !!proof && exactKeys(proof, ["issuedAt", "requestNonce", "signature"])
    && Number.isSafeInteger(proof.issuedAt) && (proof.issuedAt as number) >= 0
    && typeof proof.requestNonce === "string" && REQUEST_NONCE.test(proof.requestNonce)
    && typeof proof.signature === "string" && SIGNATURE.test(proof.signature);
}

function validPublicJwk(value: unknown): value is PublicJwk {
  const jwk = record(value);
  return !!jwk && exactKeys(jwk, ["kty", "crv", "x"])
    && jwk.kty === "OKP" && jwk.crv === "Ed25519"
    && typeof jwk.x === "string" && B64_32.test(jwk.x)
    && Buffer.from(jwk.x, "base64url").length === 32;
}

function validDisplay(value: unknown): value is ClaimDisplay {
  const display = record(value);
  return !!display && exactKeys(display, ["name", "platform", "architecture", "daemonVersion"])
    && typeof display.name === "string" && [...display.name].length >= 1 && [...display.name].length <= 120
    && ["darwin", "linux", "windows"].includes(String(display.platform))
    && ["arm64", "x64"].includes(String(display.architecture))
    && typeof display.daemonVersion === "string" && /^[\x21-\x7e]{1,64}$/.test(display.daemonVersion);
}

function assertConfigured(): void {
  if (!claimKeysConfigured()) throw claimError("UNSUPPORTED_CAPABILITY");
}

function assertBodyBounded(body: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw claimError("BAD_REQUEST");
}

function assertClock(proof: Proof, now: number): void {
  if (Math.abs(now - proof.issuedAt) > CLOCK_SKEW_MS) throw claimError("CLOCK_SKEW", { serverTime: now });
}

async function insertNonce(
  tx: Transaction,
  identity: string,
  nonce: string,
  now: number,
): Promise<boolean> {
  const existing = await tx.query(
    `SELECT 1 FROM peon_claim_request_nonces WHERE identity_key_id=$1 AND request_nonce=$2`,
    [identity, nonce],
  );
  if (existing.rows.length > 0) return false;
  const inserted = await tx.query(
    `INSERT INTO peon_claim_request_nonces (identity_key_id, request_nonce, created_at, expires_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT (identity_key_id, request_nonce) DO NOTHING
     RETURNING request_nonce`,
    [identity, nonce, now, now + NONCE_RETENTION_MS],
  );
  return inserted.rows.length > 0;
}

async function rateLimit(
  scope: string,
  subject: string,
  limit: number,
  windowMs: number,
  now: number,
  tx?: Transaction,
): Promise<void> {
  const db = tx ?? { query };
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = subjectHash(scope, subject);
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO peon_claim_rate_limits (scope, subject_hash, window_start, count)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (scope, subject_hash, window_start)
     DO UPDATE SET count = peon_claim_rate_limits.count + 1
     RETURNING count`,
    [scope, key, windowStart],
  );
  if ((rows[0]?.count ?? limit + 1) > limit) {
    throw claimError("RATE_LIMITED", { retryAfterMs: windowStart + windowMs - now });
  }
}

function verifyProof(
  body: Record<string, unknown>,
  publicJwk: PublicJwk,
  path: string,
  bindingNonce: string | null,
  now: number,
): Proof {
  const proof = body.proof;
  if (!validProof(proof)) throw claimError("BAD_REQUEST");
  assertClock(proof, now);
  if (!verifyRequestProof(publicJwk, {
    serverOrigin: canonicalOrigin(),
    path,
    bindingNonce,
    body,
  })) throw claimError("BAD_SIGNATURE");
  return proof;
}

function codeForState(state: ClaimRow["state"]): string {
  if (state === "denied") return "CLAIM_DENIED";
  if (state === "cancelled") return "CLAIM_CANCELLED";
  return "CLAIM_EXPIRED";
}

function canonicalOrigin(): string {
  return config.publicUrl;
}

function creation(row: ClaimRow, replayed: boolean, now: number): Record<string, unknown> {
  if (!row.operator_code_nonce || !row.operator_code_ciphertext || !row.operator_code_tag || !row.operator_code_key_version) {
    throw claimError("PERSIST_FAILED");
  }
  const code = openOperatorCode({
    nonce: row.operator_code_nonce,
    ciphertext: row.operator_code_ciphertext,
    tag: row.operator_code_tag,
    keyVersion: row.operator_code_key_version,
  }, row.claim_id, row.attempt_id);
  return {
    type: "claim_created", protocol: 1, claimId: row.claim_id,
    operatorCode: code, operatorUrl: `${canonicalOrigin()}/claim/${code}`,
    state: "pending", createdAt: row.created_at, expiresAt: row.expires_at,
    pollAfterMs: POLL_AFTER_MS, serverTime: now, replayed,
  };
}

function deliveryAad(row: DeliveryRow) {
  return {
    protocol: 1 as const,
    ...(row.owner_type === "claim" ? { claimId: row.owner_id } : { rotationId: row.owner_id }),
    credentialId: row.credential_id,
    peonId: row.peon_id,
    workspaceId: row.workspace_id,
    identityKeyId: row.identity_key_id,
    generation: row.generation,
  };
}

async function expireClaim(row: ClaimRow, now: number): Promise<ClaimRow> {
  const expired = row.state === "pending" && row.expires_at <= now
    || row.state === "approved" && (row.delivery_expires_at ?? 0) <= now;
  if (!expired) return row;
  await transactionWithAdvisoryLock(`peon-claim:claim:${row.claim_id}`, async (tx) => {
    const current = (await tx.query<ClaimRow>(
      `UPDATE peon_claims SET state = state WHERE claim_id = $1 RETURNING *`,
      [row.claim_id],
    )).rows[0];
    if (!current) return;
    await expireClaimInTransaction(tx, current, now);
  });
  return (await query<ClaimRow>(`SELECT * FROM peon_claims WHERE claim_id=$1`, [row.claim_id])).rows[0];
}

async function expireClaimInTransaction(tx: Transaction, current: ClaimRow, now: number): Promise<ClaimRow> {
  const stillExpired = current.state === "pending" && current.expires_at <= now
    || current.state === "approved" && (current.delivery_expires_at ?? 0) <= now;
  if (!stillExpired) return current;
  if (current.credential_id) {
    await tx.query(
      `UPDATE peon_claim_credentials SET state='revoked', revoked_at=$2
       WHERE id=$1 AND state='pending'`,
      [current.credential_id, now],
    );
  }
  await tx.query(`DELETE FROM peon_claim_deliveries WHERE owner_type='claim' AND owner_id=$1`, [current.claim_id]);
  await tx.query(
    `UPDATE peon_claims SET state='expired',operator_code_hash=NULL,operator_code_key_version=NULL,
     operator_code_nonce=NULL,operator_code_ciphertext=NULL,operator_code_tag=NULL,terminal_at=$2
     WHERE claim_id=$1`,
    [current.claim_id, now],
  );
  await tx.query(
    `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3 WHERE attempt_id=$1`,
    [current.attempt_id, now, now + TOMBSTONE_MS],
  );
  await tx.query(`DELETE FROM peon_enrollment_leases WHERE claim_id=$1`, [current.claim_id]);
  return (await tx.query<ClaimRow>(`SELECT * FROM peon_claims WHERE claim_id=$1`, [current.claim_id])).rows[0];
}

async function authenticatedClaim(
  claimId: string,
  token: string,
  body: Record<string, unknown>,
  path: string,
  now: number,
): Promise<{ auth: Pick<ClaimRow, "claim_id" | "claim_token_hash" | "peon_id" | "identity_key_id" | "public_jwk" | "claim_nonce" | "server_origin">; proof: Proof }> {
  const decoded = B64_32.test(token) ? Buffer.from(token, "base64url") : Buffer.alloc(0);
  if (decoded.length !== 32 || decoded.toString("base64url") !== token) throw claimError("UNAUTHENTICATED");
  const auth = (await query<Pick<ClaimRow, "claim_id" | "claim_token_hash" | "peon_id" | "identity_key_id" | "public_jwk" | "claim_nonce" | "server_origin">>(
    `SELECT claim_id,claim_token_hash,peon_id,identity_key_id,public_jwk,claim_nonce,server_origin
     FROM peon_claims WHERE claim_id=$1`,
    [claimId],
  )).rows[0];
  if (!auth?.claim_token_hash || !safeEqualText(auth.claim_token_hash, sha256Base64url(decoded))) throw claimError("UNAUTHENTICATED");
  const proof = verifyProof(body, auth.public_jwk, path, auth.claim_nonce, now);
  return { auth, proof };
}

async function credentialByBearer(
  bearer: string,
  allowedStates: ClaimCredentialRow["state"][],
): Promise<ClaimCredentialRow> {
  const parsed = parseBearer(bearer);
  if (!parsed) throw claimError("UNAUTHENTICATED");
  const row = (await query<ClaimCredentialRow>(`SELECT * FROM peon_claim_credentials WHERE id=$1`, [parsed.credentialId])).rows[0];
  if (!row || row.pepper_version !== 1 || !safeEqualText(row.verifier, credentialVerifier(bearer))) {
    throw claimError("UNAUTHENTICATED");
  }
  if (!allowedStates.includes(row.state)) {
    throw claimError(row.state === "revoked" ? "CREDENTIAL_REVOKED" : row.state === "retiring" ? "CREDENTIAL_RETIRED" : "CREDENTIAL_INVALID");
  }
  return row;
}

async function createDelivery(
  tx: Transaction,
  ownerType: "claim" | "rotation",
  ownerId: string,
  credentialId: string,
  peonId: string,
  workspaceId: string,
  identity: string,
  generation: number,
  bearer: string,
  now: number,
): Promise<{ deliveryId: string; expiresAt: number }> {
  const deliveryId = randomUUID();
  const expiresAt = now + DELIVERY_TTL_MS;
  const aad = {
    protocol: 1 as const,
    ...(ownerType === "claim" ? { claimId: ownerId } : { rotationId: ownerId }),
    credentialId, peonId, workspaceId, identityKeyId: identity, generation,
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const sealed = sealBearer(bearer, aad);
    const inserted = await tx.query(
      `INSERT INTO peon_claim_deliveries
       (delivery_id,owner_type,owner_id,credential_id,peon_id,workspace_id,identity_key_id,generation,key_version,nonce,ciphertext,tag,created_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (key_version,nonce) DO NOTHING RETURNING delivery_id`,
      [deliveryId, ownerType, ownerId, credentialId, peonId, workspaceId, identity, generation,
        sealed.keyVersion, sealed.nonce, sealed.ciphertext, sealed.tag, now, expiresAt],
    );
    if (inserted.rows.length > 0) return { deliveryId, expiresAt };
  }
  throw claimError("PERSIST_FAILED");
}

export async function startClaim(
  body: Record<string, unknown>,
  sourceIp: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  assertBodyBounded(body);
  if (!exactKeys(body, ["type", "protocol", "capability", "attemptId", "peonId", "serverOrigin", "claimNonce", "claimTokenHash", "identity", "display", "proof"])
    || body.type !== "claim_start" || body.protocol !== 1 || body.capability !== CLAIM_CAPABILITY
    || typeof body.attemptId !== "string" || !UUID.test(body.attemptId)
    || typeof body.peonId !== "string" || !UUID.test(body.peonId)
    || body.serverOrigin !== canonicalOrigin()
    || typeof body.claimNonce !== "string" || !B64_32.test(body.claimNonce)
    || typeof body.claimTokenHash !== "string" || !B64_32.test(body.claimTokenHash)
    || !validDisplay(body.display)) throw claimError("BAD_REQUEST");
  const identity = record(body.identity);
  if (!identity || !exactKeys(identity, ["algorithm", "keyId", "publicKey"])
    || identity.algorithm !== "Ed25519" || typeof identity.keyId !== "string"
    || !IDENTITY_KEY.test(identity.keyId) || !validPublicJwk(identity.publicKey)
    || identityKeyId(identity.publicKey) !== identity.keyId) throw claimError("INVALID_IDENTITY");
  // A new claim proves the public key carried in the frame. Durable binding,
  // attempt, replay, rate and cleanup state is deliberately untouched until
  // shape, clock and signature verification have all succeeded.
  const proof = verifyProof(body, identity.publicKey, "/api/v1/peon-claims", String(body.claimNonce), now);
  const requestHash = semanticRequestHash(body, ["attemptId", "proof"]);
  const claimId = randomUUID();
  let committedError: ClaimServiceError | null = null;
  let startReplayed = false;
  const created = await transactionWithAdvisoryLock(`peon-claim:enrollment:${String(body.peonId)}`, async (tx) => {
    if (!(await insertNonce(tx, String(identity.keyId), proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    const oldAttempt = (await tx.query<{ request_hash: string; claim_id: string; tombstone_expires_at: number | null }>(
      `SELECT request_hash,claim_id,tombstone_expires_at FROM peon_claim_attempts WHERE attempt_id=$1`,
      [body.attemptId],
    )).rows[0];
    if (oldAttempt && oldAttempt.tombstone_expires_at !== null && oldAttempt.tombstone_expires_at < now) {
      await tx.query(`DELETE FROM peon_claim_attempts WHERE attempt_id=$1`, [body.attemptId]);
    } else if (oldAttempt) {
      if (oldAttempt.request_hash !== requestHash) {
        committedError = claimError("ATTEMPT_ID_REUSED");
        return null;
      }
      let existing = (await tx.query<ClaimRow>(
        `UPDATE peon_claims SET state=state WHERE claim_id=$1 RETURNING *`,
        [oldAttempt.claim_id],
      )).rows[0];
      if (!existing) {
        committedError = claimError("ATTEMPT_RETIRED");
        return null;
      }
      existing = await expireClaimInTransaction(tx, existing, now);
      if (existing.state === "pending") {
        startReplayed = true;
        return existing;
      }
      if (existing.state === "approved" || existing.state === "completed") {
        committedError = claimError("CLAIM_ALREADY_ACTIVE", {
          state: existing.state,
          claimId: existing.claim_id,
          ...(existing.state === "approved" ? { expiresAt: existing.delivery_expires_at } : {}),
        });
        return null;
      }
      committedError = claimError(codeForState(existing.state), { state: existing.state, claimId: existing.claim_id });
      return null;
    }
    await rateLimit("claim-start-ip", sourceIp, 5, 600_000, now, tx);
    await rateLimit("claim-start-identity", String(identity.keyId), 3, 3_600_000, now, tx);
    const activeCount = Number((await tx.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM peon_claims WHERE state IN ('pending','approved')`,
    )).rows[0]?.count ?? 0);
    if (activeCount >= CLAIM_CAPACITY) {
      committedError = claimError("CLAIM_CAPACITY_EXCEEDED");
      return null;
    }
    const binding = (await tx.query<{ identity_key_id: string; workspace_id: string; method: string }>(
      `SELECT identity_key_id,workspace_id,method FROM peon_identity_bindings WHERE peon_id=$1 AND removed_at IS NULL`,
      [body.peonId],
    )).rows[0];
    if (binding && binding.identity_key_id !== identity.keyId) throw claimError("IDENTITY_KEY_MISMATCH");
    const legacy = !binding && (await tx.query(`SELECT 1 FROM peons WHERE peon_id=$1`, [body.peonId])).rows.length > 0;
    if (legacy) {
      committedError = claimError("ENROLLMENT_METHOD_LOCKED");
      return null;
    }
    const existingLease = (await tx.query<{ identity_key_id: string; method: string; claim_id: string | null; expires_at: number | null }>(
      `SELECT identity_key_id,method,claim_id,expires_at FROM peon_enrollment_leases WHERE peon_id=$1`,
      [body.peonId],
    )).rows[0];
    if (existingLease) {
      committedError = existingLease.method === "claim" && existingLease.identity_key_id === identity.keyId
        ? claimError("CLAIM_ALREADY_ACTIVE", { claimId: existingLease.claim_id, expiresAt: existingLease.expires_at })
        : claimError("ENROLLMENT_METHOD_LOCKED");
      return null;
    }
    const lease = await tx.query(
      `INSERT INTO peon_enrollment_leases (peon_id,identity_key_id,method,claim_id,created_at,expires_at)
       VALUES ($1,$2,'claim',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING peon_id`,
      [body.peonId, identity.keyId, claimId, now, now + CLAIM_TTL_MS + DELIVERY_TTL_MS],
    );
    const acquired = (await tx.query<{ identity_key_id: string; method: string; claim_id: string | null; expires_at: number | null }>(
      `SELECT identity_key_id,method,claim_id,expires_at FROM peon_enrollment_leases WHERE peon_id=$1`,
      [body.peonId],
    )).rows[0];
    if (lease.rows.length === 0 || !acquired || acquired.claim_id !== claimId) {
      committedError = acquired?.identity_key_id === identity.keyId && acquired.method === "claim"
        ? claimError("CLAIM_ALREADY_ACTIVE", { claimId: acquired.claim_id, expiresAt: acquired.expires_at })
        : claimError("ENROLLMENT_METHOD_LOCKED");
      return null;
    }
    let insertedClaim = false;
    for (let sealAttempt = 0; sealAttempt < 8 && !insertedClaim; sealAttempt += 1) {
      const code = operatorCode();
      const sealedCode = sealOperatorCode(code, claimId, String(body.attemptId));
      const inserted = await tx.query(
        `INSERT INTO peon_claims
         (claim_id,attempt_id,request_hash,peon_id,identity_key_id,public_jwk,claim_nonce,server_origin,
          claim_token_hash,operator_code_hash,operator_code_key_version,operator_code_nonce,
          operator_code_ciphertext,operator_code_tag,display,state,created_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$17)
         ON CONFLICT DO NOTHING RETURNING claim_id`,
        [claimId, body.attemptId, requestHash, body.peonId, identity.keyId, JSON.stringify(identity.publicKey),
          body.claimNonce, canonicalOrigin(), body.claimTokenHash, operatorCodeHash(code), sealedCode.keyVersion,
          sealedCode.nonce, sealedCode.ciphertext, sealedCode.tag, JSON.stringify(body.display), now, now + CLAIM_TTL_MS],
      );
      insertedClaim = inserted.rows.length > 0;
    }
    if (!insertedClaim) throw claimError("PERSIST_FAILED");
    await tx.query(
      `INSERT INTO peon_claim_attempts (attempt_id,request_hash,claim_id,terminal_at,tombstone_expires_at)
       VALUES ($1,$2,$3,NULL,NULL)`,
      [body.attemptId, requestHash, claimId],
    );
    return (await tx.query<ClaimRow>(`SELECT * FROM peon_claims WHERE claim_id=$1`, [claimId])).rows[0];
  });
  if (committedError) throw committedError;
  if (!created) throw claimError("PERSIST_FAILED");
  return creation(created, startReplayed, now);
}

export async function pollClaim(
  claimId: string,
  body: Record<string, unknown>,
  claimToken: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  if (!UUID.test(claimId) || !exactKeys(body, ["type", "protocol", "claimId", "proof"])
    || body.type !== "claim_poll" || body.protocol !== 1 || body.claimId !== claimId) throw claimError("BAD_REQUEST");
  const { auth, proof } = await authenticatedClaim(claimId, claimToken, body, `/api/v1/peon-claims/${claimId}/poll`, now);
  await rateLimit("claim-token", auth.claim_token_hash ?? claimId, 1, 1_000, now);
  const row = await transactionWithAdvisoryLock(`peon-claim:claim:${claimId}`, async (tx) => {
    if (!(await insertNonce(tx, auth.identity_key_id, proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    let current = (await tx.query<ClaimRow>(
      `UPDATE peon_claims SET state=state WHERE claim_id=$1 RETURNING *`,
      [claimId],
    )).rows[0];
    if (!current) throw claimError("UNAUTHENTICATED");
    current = await expireClaimInTransaction(tx, current, now);
    if (["denied", "expired"].includes(current.state)) {
      await tx.query(
        `UPDATE peon_claims SET terminal_polled_at=COALESCE(terminal_polled_at,$2),claim_token_hash=NULL
         WHERE claim_id=$1`,
        [claimId, now],
      );
    } else if (current.state === "approved" && current.delivered_at === null) {
      await tx.query(`UPDATE peon_claims SET delivered_at=$2 WHERE claim_id=$1`, [claimId, now]);
    }
    return current;
  });
  if (row.state === "pending") {
    return { type: "claim_status", protocol: 1, claimId, state: "pending", expiresAt: row.expires_at, pollAfterMs: POLL_AFTER_MS, serverTime: now };
  }
  if (row.state === "approved") {
    const delivery = (await query<DeliveryRow>(
      `SELECT * FROM peon_claim_deliveries WHERE owner_type='claim' AND owner_id=$1`,
      [claimId],
    )).rows[0];
    if (!delivery || delivery.expires_at <= now) throw claimError("CLAIM_EXPIRED");
    const bearer = openBearer({
      nonce: delivery.nonce,
      ciphertext: delivery.ciphertext,
      tag: delivery.tag,
      keyVersion: delivery.key_version,
    }, deliveryAad(delivery));
    const replayed = row.delivered_at !== null;
    return {
      type: "claim_status", protocol: 1, claimId, state: "approved", mode: row.mode,
      workspaceId: row.workspace_id,
      delivery: {
        deliveryId: delivery.delivery_id, credentialId: delivery.credential_id,
        generation: delivery.generation, bearer, expiresAt: delivery.expires_at,
      },
      serverTime: now, replayed,
    };
  }
  if (row.state === "completed") throw claimError("UNAUTHENTICATED");
  return { type: "claim_status", protocol: 1, claimId, state: row.state, code: codeForState(row.state), serverTime: now };
}

export async function cancelClaim(
  claimId: string,
  body: Record<string, unknown>,
  claimToken: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  if (!UUID.test(claimId) || !exactKeys(body, ["type", "protocol", "claimId", "proof"])
    || body.type !== "claim_cancel" || body.protocol !== 1 || body.claimId !== claimId) throw claimError("BAD_REQUEST");
  const { auth, proof } = await authenticatedClaim(claimId, claimToken, body, `/api/v1/peon-claims/${claimId}/cancel`, now);
  await rateLimit("claim-token", auth.claim_token_hash ?? claimId, 1, 1_000, now);
  let committedError: ClaimServiceError | null = null;
  const result = await transactionWithAdvisoryLock(`peon-claim:claim:${claimId}`, async (tx) => {
    if (!(await insertNonce(tx, auth.identity_key_id, proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    let current = (await tx.query<ClaimRow>(
      `UPDATE peon_claims SET state=state WHERE claim_id=$1 RETURNING *`,
      [claimId],
    )).rows[0];
    if (!current) {
      committedError = claimError("UNAUTHENTICATED");
      return null;
    }
    current = await expireClaimInTransaction(tx, current, now);
    if (current.state === "completed" || current.state === "cancelled") {
      committedError = claimError("CLAIM_ALREADY_DECIDED", { state: current.state });
      return null;
    }
    if (current.state === "denied" || current.state === "expired") {
      await tx.query(`UPDATE peon_claims SET claim_token_hash=NULL,terminal_polled_at=COALESCE(terminal_polled_at,$2) WHERE claim_id=$1`, [claimId, now]);
      return {
        type: "claim_cancel_result", protocol: 1, claimId, state: current.state,
        code: codeForState(current.state), changed: false, terminalAt: current.terminal_at, serverTime: now,
      };
    }
    if (current.credential_id) {
      await tx.query(
        `UPDATE peon_claim_credentials SET state='revoked',revoked_at=$2
         WHERE id=$1 AND state='pending'`,
        [current.credential_id, now],
      );
    }
    await tx.query(`DELETE FROM peon_claim_deliveries WHERE owner_type='claim' AND owner_id=$1`, [claimId]);
    await tx.query(
      `UPDATE peon_claims SET state='cancelled',claim_token_hash=NULL,operator_code_hash=NULL,
       operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
       operator_code_tag=NULL,terminal_at=$2 WHERE claim_id=$1`,
      [claimId, now],
    );
    await tx.query(
      `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3 WHERE attempt_id=$1`,
      [current.attempt_id, now, now + TOMBSTONE_MS],
    );
    await tx.query(`DELETE FROM peon_enrollment_leases WHERE claim_id=$1`, [claimId]);
    return {
      type: "claim_cancel_result", protocol: 1, claimId, state: "cancelled",
      code: "CLAIM_CANCELLED", changed: true, terminalAt: now, serverTime: now,
    };
  });
  if (committedError) throw committedError;
  if (!result) throw claimError("PERSIST_FAILED");
  return result;
}

export async function resolveClaim(
  body: Record<string, unknown>,
  sourceIp: string,
  userId: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  if (!exactKeys(body, ["type", "protocol", "operatorCode"]) || body.type !== "claim_resolve"
    || body.protocol !== 1 || typeof body.operatorCode !== "string" || !CODE.test(body.operatorCode)) {
    await rateLimit("resolve-failed-ip", sourceIp, 10, 600_000, now);
    await rateLimit("resolve-failed-user", userId, 5, 600_000, now);
    throw claimError("CLAIM_NOT_FOUND");
  }
  let row = (await query<ClaimRow>(`SELECT * FROM peon_claims WHERE operator_code_hash=$1`, [operatorCodeHash(body.operatorCode)])).rows[0];
  if (row) row = await expireClaim(row, now);
  if (!row || row.state !== "pending" || row.expires_at <= now) {
    await rateLimit("resolve-failed-ip", sourceIp, 10, 600_000, now);
    await rateLimit("resolve-failed-user", userId, 5, 600_000, now);
    throw claimError("CLAIM_NOT_FOUND");
  }
  await query(
    `INSERT INTO peon_claim_resolutions (claim_id,user_id,resolved_at,expires_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (claim_id,user_id) DO UPDATE SET resolved_at=$3,expires_at=$4`,
    [row.claim_id, userId, now, row.expires_at],
  );
  return {
    type: "claim_details", protocol: 1, claimId: row.claim_id, state: "pending",
    peonId: row.peon_id, identityKeyId: row.identity_key_id, display: row.display,
    createdAt: row.created_at, expiresAt: row.expires_at, serverTime: now,
  };
}

export async function decideClaim(
  workspaceId: string,
  claimId: string,
  decision: "approve" | "deny",
  actorUserId: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  await rateLimit("decision-user", actorUserId, 10, 600_000, now);
  return transaction(async (tx) => {
    const row = (await tx.query<ClaimRow>(
      `UPDATE peon_claims SET state=state WHERE claim_id=$1 RETURNING *`,
      [claimId],
    )).rows[0];
    if (!row) throw claimError("CLAIM_NOT_FOUND");
    const resolution = (await tx.query(
      `SELECT 1 FROM peon_claim_resolutions WHERE claim_id=$1 AND user_id=$2 AND expires_at>$3`,
      [claimId, actorUserId, now],
    )).rows.length > 0;
    if (!resolution) throw claimError("CLAIM_NOT_FOUND");
    if (decision === "approve") {
      const role = (await tx.query<{ role: string }>(
        `SELECT role FROM workspace_members
         WHERE workspace_id=$1 AND user_id=$2
         FOR UPDATE`,
        [workspaceId, actorUserId],
      )).rows[0]?.role;
      if (role !== "owner") throw claimError("FORBIDDEN");
    }
    if (row.state === "pending" && row.expires_at <= now) {
      await tx.query(
        `UPDATE peon_claims SET state='expired',operator_code_hash=NULL,operator_code_key_version=NULL,
         operator_code_nonce=NULL,operator_code_ciphertext=NULL,operator_code_tag=NULL,terminal_at=$2
         WHERE claim_id=$1`,
        [claimId, now],
      );
      await tx.query(
        `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3 WHERE attempt_id=$1`,
        [row.attempt_id, now, now + TOMBSTONE_MS],
      );
      await tx.query(
        `UPDATE peon_claim_resolutions SET expires_at=$3 WHERE claim_id=$1 AND user_id=$2`,
        [claimId, actorUserId, now + TERMINAL_RETENTION_MS],
      );
      await tx.query(`DELETE FROM peon_enrollment_leases WHERE claim_id=$1`, [claimId]);
      throw claimError("CLAIM_EXPIRED", { state: "expired" });
    }
    if (row.decision) {
      if (row.decision !== decision) throw claimError("CLAIM_ALREADY_DECIDED", { state: row.state });
      if (decision === "deny") {
        return { type: "claim_decision_result", protocol: 1, claimId, state: "denied", serverTime: now, replayed: true };
      }
      return {
        type: "claim_decision_result", protocol: 1, claimId, state: "approved", mode: row.mode,
        peonId: row.peon_id, workspaceId: row.workspace_id, credentialId: row.credential_id,
        deliveryExpiresAt: row.delivery_expires_at, serverTime: now, replayed: true,
      };
    }
    if (row.state !== "pending") throw claimError("CLAIM_ALREADY_DECIDED", { state: row.state });
    if (decision === "deny") {
      await tx.query(
        `UPDATE peon_claims SET state='denied',decision='deny',decided_by=$2,operator_code_hash=NULL,
         operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
         operator_code_tag=NULL,terminal_at=$3 WHERE claim_id=$1`,
        [claimId, actorUserId, now],
      );
      await tx.query(
        `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3 WHERE attempt_id=$1`,
        [row.attempt_id, now, now + TOMBSTONE_MS],
      );
      await tx.query(`DELETE FROM peon_enrollment_leases WHERE claim_id=$1`, [claimId]);
      await audit(tx, { claimId, peonId: row.peon_id, actorUserId, event: "claim_denied", workspaceId });
      return { type: "claim_decision_result", protocol: 1, claimId, state: "denied", serverTime: now, replayed: false };
    }

    let binding = (await tx.query<{ identity_key_id: string; public_jwk: PublicJwk; workspace_id: string; method: string }>(
      `SELECT identity_key_id,public_jwk,workspace_id,method FROM peon_identity_bindings WHERE peon_id=$1 AND removed_at IS NULL`,
      [row.peon_id],
    )).rows[0];
    const keyBinding = (await tx.query<{ peon_id: string; workspace_id: string }>(
      `SELECT peon_id,workspace_id FROM peon_identity_bindings
       WHERE identity_key_id=$1 AND removed_at IS NULL`,
      [row.identity_key_id],
    )).rows[0];
    if (keyBinding && keyBinding.peon_id !== row.peon_id) throw claimError("PEON_ALREADY_CLAIMED");
    if (!binding) {
      await tx.query(
        `INSERT INTO peon_identity_bindings (peon_id,identity_key_id,public_jwk,workspace_id,method,created_at,removed_at)
         VALUES ($1,$2,$3,$4,'claim',$5,NULL) ON CONFLICT (peon_id) DO NOTHING`,
        [row.peon_id, row.identity_key_id, JSON.stringify(row.public_jwk), workspaceId, now],
      );
      binding = (await tx.query<{ identity_key_id: string; public_jwk: PublicJwk; workspace_id: string; method: string }>(
        `SELECT identity_key_id,public_jwk,workspace_id,method FROM peon_identity_bindings WHERE peon_id=$1 AND removed_at IS NULL`,
        [row.peon_id],
      )).rows[0];
    }
    if (!binding || binding.identity_key_id !== row.identity_key_id) throw claimError("IDENTITY_KEY_MISMATCH");
    if (binding.workspace_id !== workspaceId) throw claimError("PEON_ALREADY_CLAIMED");
    if (binding.method !== "claim") throw claimError("ENROLLMENT_METHOD_LOCKED");
    const mode = (await tx.query(`SELECT 1 FROM peon_claim_credentials WHERE peon_id=$1`, [row.peon_id])).rows.length ? "recover" : "new";
    const max = (await tx.query<{ generation: number | null }>(
      `SELECT MAX(generation) AS generation FROM peon_claim_credentials WHERE peon_id=$1`,
      [row.peon_id],
    )).rows[0]?.generation;
    const generation = (max ?? 0) + 1;
    const credentialId = randomUUID();
    const bearer = mintBearer(credentialId);
    await tx.query(
      `INSERT INTO peon_claim_credentials
       (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,1,$7,$8)`,
      [credentialId, workspaceId, row.peon_id, row.identity_key_id, generation, credentialVerifier(bearer), actorUserId, now],
    );
    const delivery = await createDelivery(tx, "claim", claimId, credentialId, row.peon_id, workspaceId, row.identity_key_id, generation, bearer, now);
    await tx.query(
      `INSERT INTO peon_claim_ack_auth
       (claim_id,delivery_id,credential_id,peon_id,identity_key_id,public_jwk,claim_nonce,server_origin,generation,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [claimId, delivery.deliveryId, credentialId, row.peon_id, row.identity_key_id,
        JSON.stringify(row.public_jwk), row.claim_nonce, row.server_origin, generation, now + TOMBSTONE_MS],
    );
    await tx.query(
      `UPDATE peon_claims SET state='approved',mode=$2,workspace_id=$3,decided_by=$4,decision='approve',
       credential_id=$5,delivery_id=$6,delivery_expires_at=$7,operator_code_hash=NULL,
       operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
       operator_code_tag=NULL WHERE claim_id=$1`,
      [claimId, mode, workspaceId, actorUserId, credentialId, delivery.deliveryId, delivery.expiresAt],
    );
    await tx.query(`UPDATE peon_enrollment_leases SET expires_at=$2 WHERE claim_id=$1`, [claimId, delivery.expiresAt]);
    await tx.query(
      `UPDATE peon_claim_resolutions SET expires_at=$3 WHERE claim_id=$1 AND user_id=$2`,
      [claimId, actorUserId, delivery.expiresAt],
    );
    await audit(tx, { claimId, credentialId, peonId: row.peon_id, actorUserId, event: `claim_approved_${mode}`, workspaceId });
    return {
      type: "claim_decision_result", protocol: 1, claimId, state: "approved", mode,
      peonId: row.peon_id, workspaceId, credentialId, deliveryExpiresAt: delivery.expiresAt,
      serverTime: now, replayed: false,
    };
  });
}

export async function acknowledgeClaim(
  claimId: string,
  body: Record<string, unknown>,
  bearer: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  if (!UUID.test(claimId) || !exactKeys(body, ["type", "protocol", "claimId", "deliveryId", "credentialId", "generation", "proof"])
    || body.type !== "claim_ack" || body.protocol !== 1 || body.claimId !== claimId
    || typeof body.deliveryId !== "string" || !UUID.test(body.deliveryId)
    || typeof body.credentialId !== "string" || !UUID.test(body.credentialId)
    || !Number.isInteger(body.generation) || (body.generation as number) < 1) throw claimError("BAD_REQUEST");
  const parsed = parseBearer(bearer);
  if (!parsed || parsed.credentialId !== body.credentialId) throw claimError("UNAUTHENTICATED");
  const auth = (await query<{
    credential_id: string; verifier: string; pepper_version: number; credential_state: ClaimCredentialRow["state"];
    generation: number; peon_id: string; identity_key_id: string; public_jwk: PublicJwk;
    claim_nonce: string; server_origin: string;
  }>(
    `SELECT c.id AS credential_id,c.verifier,c.pepper_version,c.state AS credential_state,c.generation,
            c.peon_id,c.identity_key_id,a.public_jwk,a.claim_nonce,a.server_origin
     FROM peon_claim_credentials c
     JOIN peon_claim_ack_auth a ON a.claim_id=$1 AND a.credential_id=c.id
     WHERE c.id=$2 AND a.delivery_id=$3`,
    [claimId, parsed.credentialId, body.deliveryId],
  )).rows[0];
  if (!auth || auth.pepper_version !== 1 || !safeEqualText(auth.verifier, credentialVerifier(bearer))) {
    throw claimError("UNAUTHENTICATED");
  }
  const proof = verifyProof(body, auth.public_jwk, `/api/v1/peon-claims/${claimId}/ack`, auth.claim_nonce, now);
  if (auth.credential_state === "revoked") throw claimError("CREDENTIAL_REVOKED");
  if (!["pending", "active"].includes(auth.credential_state)) throw claimError("CREDENTIAL_INVALID");
  const requestHash = semanticRequestHash(body, ["proof"]);
  let committedError: ClaimServiceError | null = null;
  let replayed = false;
  const completed = await transactionWithAdvisoryLock(`peon-claim:claim:${claimId}`, async (tx) => {
    const currentCredential = (await tx.query<ClaimCredentialRow>(
      `UPDATE peon_claim_credentials SET state=state WHERE id=$1 RETURNING *`,
      [auth.credential_id],
    )).rows[0];
    if (!currentCredential || currentCredential.state === "revoked") throw claimError("CREDENTIAL_REVOKED");
    if (!(await insertNonce(tx, auth.identity_key_id, proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    let current = (await tx.query<ClaimRow>(`UPDATE peon_claims SET state=state WHERE claim_id=$1 RETURNING *`, [claimId])).rows[0];
    if (!current) {
      committedError = claimError("CLAIM_NOT_FOUND");
      return null;
    }
    current = await expireClaimInTransaction(tx, current, now);
    if (current.state === "completed") {
      if (!current.ack_result_expires_at || current.ack_result_expires_at < now) {
        committedError = claimError("CLAIM_NOT_FOUND");
        return null;
      }
      if (current.ack_request_hash !== requestHash) {
        committedError = claimError("CLAIM_ACK_MISMATCH");
        return null;
      }
      replayed = true;
      return current;
    }
    if (current.state !== "approved") {
      committedError = current.state === "cancelled" || current.state === "expired"
        ? claimError("CREDENTIAL_REVOKED")
        : claimError("CLAIM_ALREADY_DECIDED", { state: current.state });
      return null;
    }
    if (body.deliveryId !== current.delivery_id || body.credentialId !== currentCredential.id
      || body.generation !== currentCredential.generation) {
      committedError = claimError("CLAIM_ACK_MISMATCH");
      return null;
    }
    await tx.query(`UPDATE peon_claim_credentials SET state='active',activated_at=$2 WHERE id=$1 AND state='pending'`, [currentCredential.id, now]);
    if (current.mode === "recover") {
      await tx.query(
        `UPDATE peon_claim_credentials SET state='revoked',revoked_at=$3
         WHERE peon_id=$1 AND id<>$2 AND state IN ('pending','active','retiring')`,
        [current.peon_id, currentCredential.id, now],
      );
    }
    await tx.query(`DELETE FROM peon_claim_deliveries WHERE owner_type='claim' AND owner_id=$1`, [claimId]);
    await tx.query(
      `UPDATE peon_claims SET state='completed',claim_token_hash=NULL,operator_code_hash=NULL,
       operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
       operator_code_tag=NULL,terminal_at=$2,completed_at=$2,ack_request_hash=$3,
       ack_result_expires_at=$4 WHERE claim_id=$1`,
      [claimId, now, requestHash, now + TERMINAL_RETENTION_MS],
    );
    await tx.query(
      `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3 WHERE attempt_id=$1`,
      [current.attempt_id, now, now + TOMBSTONE_MS],
    );
    await tx.query(`DELETE FROM peon_enrollment_leases WHERE claim_id=$1`, [claimId]);
    await tx.query(
      `INSERT INTO peons
       (peon_id,credential_id,workspace_id,name,hostname,address,control_port,public_url,address_source,protocol,capabilities,token,load,registered_at,last_seen)
       VALUES ($1,$2,$3,$4,NULL,'',0,NULL,'discovered',NULL,'[]','',NULL,$5,0)
       ON CONFLICT (peon_id) DO UPDATE SET credential_id=EXCLUDED.credential_id,workspace_id=EXCLUDED.workspace_id,name=EXCLUDED.name,token=''`,
      [current.peon_id, currentCredential.id, current.workspace_id, current.display.name, now],
    );
    await audit(tx, {
      claimId, credentialId: currentCredential.id, peonId: current.peon_id,
      event: current.mode === "recover" ? "claim_recovery_completed" : "claim_completed",
      workspaceId: current.workspace_id ?? undefined,
    });
    return (await tx.query<ClaimRow>(`SELECT * FROM peon_claims WHERE claim_id=$1`, [claimId])).rows[0];
  });
  if (committedError) throw committedError;
  if (!completed) throw claimError("PERSIST_FAILED");
  const credential = (await query<ClaimCredentialRow>(`SELECT * FROM peon_claim_credentials WHERE id=$1`, [auth.credential_id])).rows[0];
  if (completed.mode === "recover") {
    evictPeonConnection(completed.peon_id);
    evictPeonTransferConnection(completed.peon_id);
  }
  return completedClaim(completed, credential, now, replayed);
}

function completedClaim(row: ClaimRow, credential: ClaimCredentialRow, now: number, replayed: boolean): Record<string, unknown> {
  return {
    type: "claim_completed", protocol: 1, claimId: row.claim_id, state: "completed",
    peonId: row.peon_id, workspaceId: row.workspace_id, credentialId: credential.id,
    generation: credential.generation, completedAt: row.completed_at, serverTime: now, replayed,
  };
}

interface RotationRow {
  rotation_id: string;
  request_hash: string;
  peon_id: string;
  workspace_id: string;
  identity_key_id: string;
  previous_credential_id: string;
  previous_generation: number;
  credential_id: string;
  delivery_id: string;
  state: "pending_ack" | "completed" | "expired" | "cancelled";
  created_at: number;
  expires_at: number;
  delivered_at: number | null;
  completed_at: number | null;
  old_socket_grace_ends_at: number | null;
  terminal_at: number | null;
  ack_request_hash: string | null;
  ack_result_expires_at: number | null;
  tombstone_expires_at: number | null;
}

async function rotationDelivery(row: RotationRow, now: number, replayed: boolean): Promise<Record<string, unknown>> {
  const delivery = (await query<DeliveryRow>(`SELECT * FROM peon_claim_deliveries WHERE owner_type='rotation' AND owner_id=$1`, [row.rotation_id])).rows[0];
  if (!delivery || delivery.expires_at <= now) {
    await expireRotation(row, now);
    throw claimError("ROTATION_EXPIRED");
  }
  return {
    type: "credential_rotation_delivery", protocol: 1, rotationId: row.rotation_id,
    state: "pending_ack", peonId: row.peon_id, previousCredentialId: row.previous_credential_id,
    previousGeneration: row.previous_generation,
    delivery: {
      deliveryId: delivery.delivery_id, credentialId: delivery.credential_id,
      generation: delivery.generation,
      bearer: openBearer({
        nonce: delivery.nonce,
        ciphertext: delivery.ciphertext,
        tag: delivery.tag,
        keyVersion: delivery.key_version,
      }, deliveryAad(delivery)),
      expiresAt: delivery.expires_at,
    },
    serverTime: now, replayed,
  };
}

async function expireRotation(row: RotationRow, now: number): Promise<void> {
  if (row.state !== "pending_ack" || row.expires_at > now) return;
  await transactionWithAdvisoryLock(`peon-claim:rotation:${row.rotation_id}`, async (tx) => {
    const current = (await tx.query<RotationRow>(
      `UPDATE peon_credential_rotations SET state=state WHERE rotation_id=$1 RETURNING *`,
      [row.rotation_id],
    )).rows[0];
    if (current) await expireRotationInTransaction(tx, current, now);
  });
}

async function expireRotationInTransaction(tx: Transaction, row: RotationRow, now: number): Promise<void> {
  if (row.state !== "pending_ack" || row.expires_at > now) return;
  await tx.query(
    `UPDATE peon_credential_rotations SET state='expired',terminal_at=$2,tombstone_expires_at=$3
     WHERE rotation_id=$1 AND state='pending_ack'`,
    [row.rotation_id, now, now + TOMBSTONE_MS],
  );
  await tx.query(`UPDATE peon_claim_credentials SET state='revoked',revoked_at=$2 WHERE id=$1 AND state='pending'`, [row.credential_id, now]);
  await tx.query(`DELETE FROM peon_claim_deliveries WHERE owner_type='rotation' AND owner_id=$1`, [row.rotation_id]);
}

export async function startRotation(
  body: Record<string, unknown>,
  bearer: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  assertConfigured();
  if (!exactKeys(body, ["type", "protocol", "capability", "rotationId", "peonId", "identityKeyId", "currentCredentialId", "currentGeneration", "serverOrigin", "proof"])
    || body.type !== "credential_rotation_start" || body.protocol !== 1 || body.capability !== CLAIM_CAPABILITY
    || typeof body.rotationId !== "string" || !UUID.test(body.rotationId)
    || typeof body.peonId !== "string" || !UUID.test(body.peonId)
    || typeof body.identityKeyId !== "string" || !IDENTITY_KEY.test(body.identityKeyId)
    || typeof body.currentCredentialId !== "string" || !UUID.test(body.currentCredentialId)
    || !Number.isInteger(body.currentGeneration) || (body.currentGeneration as number) < 1
    || body.serverOrigin !== canonicalOrigin()) throw claimError("BAD_REQUEST");
  const parsed = parseBearer(bearer);
  if (!parsed || parsed.credentialId !== body.currentCredentialId) throw claimError("UNAUTHENTICATED");
  const auth = (await query<ClaimCredentialRow & { public_jwk: PublicJwk; server_origin: string }>(
    `SELECT c.*,b.public_jwk,$2 AS server_origin
     FROM peon_claim_credentials c
     JOIN peon_identity_bindings b ON b.peon_id=c.peon_id AND b.identity_key_id=c.identity_key_id AND b.removed_at IS NULL
     WHERE c.id=$1`,
    [parsed.credentialId, canonicalOrigin()],
  )).rows[0];
  if (!auth || auth.pepper_version !== 1 || !safeEqualText(auth.verifier, credentialVerifier(bearer))) throw claimError("UNAUTHENTICATED");
  const proof = verifyProof(body, auth.public_jwk, "/api/v1/peon-credentials/rotations", null, now);
  if (auth.state === "revoked") throw claimError("CREDENTIAL_REVOKED");
  if (auth.state === "retiring") throw claimError("CREDENTIAL_RETIRED");
  if (auth.state !== "active") throw claimError("CREDENTIAL_INVALID");
  if (auth.peon_id !== body.peonId || auth.identity_key_id !== body.identityKeyId
    || auth.id !== body.currentCredentialId || auth.generation !== body.currentGeneration) {
    throw claimError("CREDENTIAL_GENERATION_MISMATCH");
  }
  const requestHash = semanticRequestHash(body, ["rotationId", "proof"]);
  await rateLimit("rotation-peon", auth.peon_id, 3, 86_400_000, now);
  let committedError: ClaimServiceError | null = null;
  const nextId = randomUUID();
  const nextBearer = mintBearer(nextId);
  let replayed = false;
  const result = await transactionWithAdvisoryLock(`peon-claim:rotation:${String(body.rotationId)}`, async (tx) => {
    const currentCredential = (await tx.query<ClaimCredentialRow>(
      `UPDATE peon_claim_credentials SET state=state WHERE id=$1 RETURNING *`,
      [auth.id],
    )).rows[0];
    if (!currentCredential || currentCredential.state === "revoked") throw claimError("CREDENTIAL_REVOKED");
    if (currentCredential.state === "retiring") throw claimError("CREDENTIAL_RETIRED");
    if (currentCredential.state !== "active") throw claimError("CREDENTIAL_INVALID");
    if (!(await insertNonce(tx, auth.identity_key_id, proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    const old = (await tx.query<RotationRow>(
      `UPDATE peon_credential_rotations SET state=state WHERE rotation_id=$1 RETURNING *`,
      [body.rotationId],
    )).rows[0];
    if (old) {
      if (old.request_hash !== requestHash) {
        committedError = claimError("ROTATION_ID_REUSED");
        return null;
      }
      if (old.state === "completed") {
        replayed = true;
        return old;
      }
      if (old.state !== "pending_ack" || old.expires_at <= now) {
        await expireRotationInTransaction(tx, old, now);
        committedError = claimError("ROTATION_EXPIRED");
        return null;
      }
      replayed = true;
      return old;
    }
    const active = (await tx.query<RotationRow>(
      `SELECT * FROM peon_credential_rotations WHERE peon_id=$1 AND state='pending_ack'`,
      [auth.peon_id],
    )).rows[0];
    if (active) {
      committedError = claimError("ROTATION_ALREADY_ACTIVE");
      return null;
    }
    await tx.query(
      `INSERT INTO peon_claim_credentials
       (id,workspace_id,peon_id,identity_key_id,generation,state,verifier,pepper_version,created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,1,$7)`,
      [nextId, auth.workspace_id, auth.peon_id, auth.identity_key_id,
        auth.generation + 1, credentialVerifier(nextBearer), now],
    );
    const delivery = await createDelivery(tx, "rotation", String(body.rotationId), nextId,
      auth.peon_id, auth.workspace_id, auth.identity_key_id, auth.generation + 1, nextBearer, now);
    await tx.query(
      `INSERT INTO peon_credential_rotations
       (rotation_id,request_hash,peon_id,workspace_id,identity_key_id,previous_credential_id,previous_generation,
        credential_id,delivery_id,state,created_at,expires_at,tombstone_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_ack',$10,$11,$12)`,
      [body.rotationId, requestHash, auth.peon_id, auth.workspace_id, auth.identity_key_id,
        auth.id, auth.generation, nextId, delivery.deliveryId, now, delivery.expiresAt, null],
    );
    return (await tx.query<RotationRow>(`SELECT * FROM peon_credential_rotations WHERE rotation_id=$1`, [body.rotationId])).rows[0];
  });
  if (committedError) throw committedError;
  if (!result) throw claimError("PERSIST_FAILED");
  if (result.state === "completed") return completedRotation(result, now, true);
  return rotationDelivery(result, now, replayed);
}

export async function pollRotation(
  rotationId: string,
  body: Record<string, unknown>,
  bearer: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (!UUID.test(rotationId) || !exactKeys(body, ["type", "protocol", "rotationId", "proof"])
    || body.type !== "credential_rotation_poll" || body.protocol !== 1 || body.rotationId !== rotationId) throw claimError("BAD_REQUEST");
  const parsed = parseBearer(bearer);
  if (!parsed) throw claimError("UNAUTHENTICATED");
  const auth = (await query<{
    credential_id: string; verifier: string; pepper_version: number; credential_state: ClaimCredentialRow["state"];
    peon_id: string; identity_key_id: string; public_jwk: PublicJwk;
  }>(
    `SELECT c.id AS credential_id,c.verifier,c.pepper_version,c.state AS credential_state,
            c.peon_id,c.identity_key_id,b.public_jwk
     FROM peon_credential_rotations r
     JOIN peon_claim_credentials c ON c.id=r.previous_credential_id
     JOIN peon_identity_bindings b ON b.peon_id=c.peon_id AND b.identity_key_id=c.identity_key_id AND b.removed_at IS NULL
     WHERE r.rotation_id=$1 AND c.id=$2`,
    [rotationId, parsed.credentialId],
  )).rows[0];
  if (!auth || auth.pepper_version !== 1 || !safeEqualText(auth.verifier, credentialVerifier(bearer))) throw claimError("UNAUTHENTICATED");
  const proof = verifyProof(body, auth.public_jwk, `/api/v1/peon-credentials/rotations/${rotationId}/poll`, null, now);
  if (auth.credential_state === "revoked") throw claimError("CREDENTIAL_REVOKED");
  if (auth.credential_state === "retiring") throw claimError("CREDENTIAL_RETIRED");
  if (auth.credential_state !== "active") throw claimError("CREDENTIAL_INVALID");
  let pollError: ClaimServiceError | null = null;
  let wasDelivered = false;
  const row = await transactionWithAdvisoryLock(`peon-claim:rotation:${rotationId}`, async (tx) => {
    if (!(await insertNonce(tx, auth.identity_key_id, proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    const before = (await tx.query<RotationRow>(
      `UPDATE peon_credential_rotations SET state=state WHERE rotation_id=$1 RETURNING *`,
      [rotationId],
    )).rows[0];
    if (!before) throw claimError("UNAUTHENTICATED");
    wasDelivered = before.delivered_at !== null;
    const current = (await tx.query<RotationRow>(
      `UPDATE peon_credential_rotations SET delivered_at=COALESCE(delivered_at,$2)
       WHERE rotation_id=$1 RETURNING *`,
      [rotationId, now],
    )).rows[0];
    if (current.state !== "pending_ack" || current.expires_at <= now) {
      await expireRotationInTransaction(tx, current, now);
      pollError = claimError("ROTATION_EXPIRED");
      return null;
    }
    return current;
  });
  if (pollError) throw pollError;
  if (!row) throw claimError("PERSIST_FAILED");
  return rotationDelivery(row, now, wasDelivered);
}

export async function acknowledgeRotation(
  rotationId: string,
  body: Record<string, unknown>,
  bearer: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (!UUID.test(rotationId) || !exactKeys(body, ["type", "protocol", "rotationId", "deliveryId", "credentialId", "generation", "proof"])
    || body.type !== "credential_rotation_ack" || body.protocol !== 1 || body.rotationId !== rotationId
    || typeof body.deliveryId !== "string" || !UUID.test(body.deliveryId)
    || typeof body.credentialId !== "string" || !UUID.test(body.credentialId)
    || !Number.isInteger(body.generation) || (body.generation as number) < 2) throw claimError("BAD_REQUEST");
  const parsed = parseBearer(bearer);
  if (!parsed || parsed.credentialId !== body.credentialId) throw claimError("UNAUTHENTICATED");
  const auth = (await query<{
    credential_id: string; verifier: string; pepper_version: number; credential_state: ClaimCredentialRow["state"];
    generation: number; peon_id: string; identity_key_id: string; public_jwk: PublicJwk;
  }>(
    `SELECT c.id AS credential_id,c.verifier,c.pepper_version,c.state AS credential_state,c.generation,
            c.peon_id,c.identity_key_id,b.public_jwk
     FROM peon_credential_rotations r
     JOIN peon_claim_credentials c ON c.id=r.credential_id
     JOIN peon_identity_bindings b ON b.peon_id=c.peon_id AND b.identity_key_id=c.identity_key_id AND b.removed_at IS NULL
     WHERE r.rotation_id=$1 AND r.delivery_id=$2 AND c.id=$3`,
    [rotationId, body.deliveryId, parsed.credentialId],
  )).rows[0];
  if (!auth || auth.pepper_version !== 1 || !safeEqualText(auth.verifier, credentialVerifier(bearer))) throw claimError("UNAUTHENTICATED");
  const proof = verifyProof(body, auth.public_jwk, `/api/v1/peon-credentials/rotations/${rotationId}/ack`, null, now);
  if (auth.credential_state === "revoked") throw claimError("CREDENTIAL_REVOKED");
  if (!["pending", "active"].includes(auth.credential_state)) throw claimError("CREDENTIAL_INVALID");
  const requestHash = semanticRequestHash(body, ["proof"]);
  const graceEnds = now + OLD_SOCKET_GRACE_MS;
  let committedError: ClaimServiceError | null = null;
  let replayed = false;
  const row = await transactionWithAdvisoryLock(`peon-claim:rotation:${rotationId}`, async (tx) => {
    const currentCredential = (await tx.query<ClaimCredentialRow>(
      `UPDATE peon_claim_credentials SET state=state WHERE id=$1 RETURNING *`,
      [auth.credential_id],
    )).rows[0];
    if (!currentCredential || currentCredential.state === "revoked") throw claimError("CREDENTIAL_REVOKED");
    if (!(await insertNonce(tx, auth.identity_key_id, proof.requestNonce, now))) throw claimError("REQUEST_REPLAYED");
    const current = (await tx.query<RotationRow>(
      `UPDATE peon_credential_rotations SET state=state WHERE rotation_id=$1 RETURNING *`,
      [rotationId],
    )).rows[0];
    if (!current) {
      committedError = claimError("ROTATION_EXPIRED");
      return null;
    }
    if (current.state === "completed") {
      if (!current.ack_result_expires_at || current.ack_result_expires_at < now) {
        committedError = claimError("ROTATION_EXPIRED");
        return null;
      }
      if (current.ack_request_hash !== requestHash) {
        committedError = claimError("ROTATION_ACK_MISMATCH");
        return null;
      }
      replayed = true;
      return current;
    }
    if (current.state !== "pending_ack" || current.expires_at <= now) {
      await expireRotationInTransaction(tx, current, now);
      committedError = claimError("ROTATION_EXPIRED");
      return null;
    }
    if (body.deliveryId !== current.delivery_id || body.credentialId !== currentCredential.id
      || body.generation !== currentCredential.generation) {
      committedError = claimError("ROTATION_ACK_MISMATCH");
      return null;
    }
    await tx.query(`UPDATE peon_claim_credentials SET state='active',activated_at=$2 WHERE id=$1 AND state='pending'`, [currentCredential.id, now]);
    await tx.query(
      `UPDATE peon_claim_credentials SET state='retiring',retiring_at=$2,old_socket_grace_ends_at=$3 WHERE id=$1 AND state='active'`,
      [current.previous_credential_id, now, graceEnds],
    );
    await tx.query(`DELETE FROM peon_claim_deliveries WHERE owner_type='rotation' AND owner_id=$1`, [rotationId]);
    await tx.query(
      `UPDATE peon_credential_rotations SET state='completed',completed_at=$2,terminal_at=$2,
       old_socket_grace_ends_at=$3,ack_request_hash=$4,ack_result_expires_at=$5,
       tombstone_expires_at=$6 WHERE rotation_id=$1`,
      [rotationId, now, graceEnds, requestHash, now + TERMINAL_RETENTION_MS, now + TOMBSTONE_MS],
    );
    await tx.query(`UPDATE peons SET credential_id=$2,token='' WHERE peon_id=$1`, [current.peon_id, currentCredential.id]);
    await audit(tx, { credentialId: currentCredential.id, peonId: current.peon_id, workspaceId: current.workspace_id, event: "credential_rotated" });
    return (await tx.query<RotationRow>(`SELECT * FROM peon_credential_rotations WHERE rotation_id=$1`, [rotationId])).rows[0];
  });
  if (committedError) throw committedError;
  if (!row) throw claimError("PERSIST_FAILED");
  if (replayed) return completedRotation(row, now, true);
  const timer = setTimeout(() => {
    evictPeonConnectionsBelowGeneration(row.peon_id, auth.generation);
    evictPeonTransferConnectionsBelowGeneration(row.peon_id, auth.generation);
  }, OLD_SOCKET_GRACE_MS);
  timer.unref();
  return completedRotation(row, now, false);
}

function completedRotation(row: RotationRow, now: number, replayed: boolean): Record<string, unknown> {
  return {
    type: "credential_rotation_completed", protocol: 1, rotationId: row.rotation_id, state: "completed",
    peonId: row.peon_id, credentialId: row.credential_id, generation: row.previous_generation + 1,
    previousCredentialId: row.previous_credential_id, oldSocketGraceEndsAt: row.old_socket_grace_ends_at,
    completedAt: row.completed_at, serverTime: now, replayed,
  };
}

export async function revokeClaimCredential(
  workspaceId: string,
  peonId: string,
  credentialId: string,
  actorUserId: string,
  requestId: string = randomUUID(),
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  const result = await transactionWithAdvisoryLock(`peon-claim:revoke-credential:${credentialId}`, async (tx) => {
    const target = (await tx.query<ClaimCredentialRow>(
      `UPDATE peon_claim_credentials SET state=state
       WHERE id=$1 AND workspace_id=$2 AND peon_id=$3 RETURNING *`,
      [credentialId, workspaceId, peonId],
    )).rows[0];
    if (!target) return null;
    const changed = target.state !== "revoked";
    const revokedAt = target.revoked_at ?? now;
    if (changed) {
      await tx.query(
        `UPDATE peon_claim_credentials SET state='revoked',revoked_at=$2 WHERE id=$1`,
        [credentialId, now],
      );
    }
    await tx.query(`DELETE FROM peon_claim_deliveries WHERE credential_id=$1`, [credentialId]);
    await tx.query(
      `UPDATE peon_claims SET state='cancelled',claim_token_hash=NULL,operator_code_hash=NULL,
       operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
       operator_code_tag=NULL,terminal_at=$2
       WHERE credential_id=$1 AND state='approved'`,
      [credentialId, now],
    );
    await tx.query(
      `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3
       WHERE claim_id IN (SELECT claim_id FROM peon_claims WHERE credential_id=$1 AND state='cancelled')`,
      [credentialId, now, now + TOMBSTONE_MS],
    );
    await tx.query(
      `UPDATE peon_credential_rotations SET state='cancelled'
       WHERE credential_id=$1 AND state='pending_ack'`,
      [credentialId],
    );
    await audit(tx, {
      workspaceId, peonId, credentialId, actorUserId, requestId,
      event: "credential.revoked", scope: "credential",
      outcome: changed ? "revoked" : "already_revoked",
      stableCode: "CREDENTIAL_REVOKED", revokedAt,
    });
    return { changed, revokedAt, generation: target.generation };
  });
  if (!result) return null;
  const evictedSocketCount = result.changed
    ? Number(evictPeonConnectionGeneration(peonId, result.generation))
      + Number(evictPeonTransferConnectionGeneration(peonId, result.generation))
    : 0;
  return {
    type: "revocation_result", protocol: 1, scope: "credential", code: "CREDENTIAL_REVOKED",
    workspaceId, peonId, credentialId, changed: result.changed,
    revokedCredentialCount: result.changed ? 1 : 0,
    evictedSocketCount, revokedAt: result.revokedAt, serverTime: now,
  };
}

export async function revokeClaimPeon(
  workspaceId: string,
  peonId: string,
  actorUserId: string,
  requestId: string = randomUUID(),
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
  const result = await transactionWithAdvisoryLock(`peon-claim:revoke-peon:${peonId}`, async (tx) => {
    const binding = (await tx.query(
      `SELECT 1 FROM peon_identity_bindings WHERE peon_id=$1 AND workspace_id=$2 AND removed_at IS NULL`,
      [peonId, workspaceId],
    )).rows.length > 0;
    if (!binding) return null;
    const current = (await tx.query<{ count: number; revoked_at: number | null }>(
      `SELECT COUNT(*) AS count,MIN(revoked_at) AS revoked_at FROM peon_claim_credentials
       WHERE peon_id=$1 AND workspace_id=$2 AND state<>'revoked'`,
      [peonId, workspaceId],
    )).rows[0];
    const legacy = Number((await tx.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM peon_credentials
       WHERE workspace_id=$1 AND bound_peon_id=$2 AND revoked_at IS NULL`,
      [workspaceId, peonId],
    )).rows[0]?.count ?? 0);
    const activeClaims = Number((await tx.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM peon_claims WHERE peon_id=$1 AND state IN ('pending','approved')`,
      [peonId],
    )).rows[0]?.count ?? 0);
    const changed = Number(current?.count ?? 0) + legacy + activeClaims > 0;
    const prior = (await tx.query<{ revoked_at: number }>(
      `SELECT revoked_at FROM peon_claim_peon_revocations WHERE peon_id=$1 AND workspace_id=$2`,
      [peonId, workspaceId],
    )).rows[0];
    const revokedAt = changed || !prior ? now : prior.revoked_at;
    const revokedCredentials = Number(current?.count ?? 0) + legacy;
    await tx.query(
      `UPDATE peon_claim_credentials SET state='revoked',revoked_at=$3
       WHERE peon_id=$1 AND workspace_id=$2 AND state<>'revoked'`,
      [peonId, workspaceId, now],
    );
    await tx.query(
      `UPDATE peon_claims SET state='cancelled',claim_token_hash=NULL,operator_code_hash=NULL,
       operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
       operator_code_tag=NULL,terminal_at=$3
       WHERE peon_id=$1 AND (workspace_id=$2 OR workspace_id IS NULL) AND state IN ('pending','approved')`,
      [peonId, workspaceId, now],
    );
    await tx.query(
      `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3
       WHERE claim_id IN (SELECT claim_id FROM peon_claims WHERE peon_id=$1 AND state='cancelled')`,
      [peonId, now, now + TOMBSTONE_MS],
    );
    await tx.query(
      `UPDATE peon_credential_rotations SET state='cancelled',terminal_at=$3,tombstone_expires_at=$4
       WHERE peon_id=$1 AND workspace_id=$2 AND state='pending_ack'`,
      [peonId, workspaceId, now, now + TOMBSTONE_MS],
    );
    await tx.query(
      `UPDATE peon_credentials SET revoked_at=$3
       WHERE workspace_id=$1 AND bound_peon_id=$2 AND revoked_at IS NULL`,
      [workspaceId, peonId, now],
    );
    await tx.query(`DELETE FROM peon_claim_deliveries WHERE peon_id=$1 AND workspace_id=$2`, [peonId, workspaceId]);
    await tx.query(`DELETE FROM peon_enrollment_leases WHERE peon_id=$1`, [peonId]);
    await tx.query(
      `INSERT INTO peon_claim_peon_revocations (peon_id,workspace_id,revoked_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (peon_id) DO UPDATE SET workspace_id=$2,revoked_at=$3`,
      [peonId, workspaceId, revokedAt],
    );
    await audit(tx, {
      workspaceId, peonId, actorUserId, requestId, event: "peon.revoked", scope: "peon",
      outcome: changed ? "revoked" : "already_revoked", stableCode: "PEON_REVOKED", revokedAt,
    });
    return { changed, revokedAt, revokedCredentials };
  });
  if (!result) return null;
  const evictedSocketCount = result.changed
    ? Number(evictPeonConnection(peonId)) + Number(evictPeonTransferConnection(peonId))
    : 0;
  return {
    type: "revocation_result", protocol: 1, scope: "peon", code: "PEON_REVOKED",
    workspaceId, peonId, changed: result.changed,
    revokedCredentialCount: result.changed ? result.revokedCredentials : 0,
    evictedSocketCount, revokedAt: result.revokedAt, serverTime: now,
  };
}

// The established fleet DELETE endpoint predates peon-claim-v1. Keep its
// response contract while making its credential boundary cover both formats
// atomically, including pending delivery material that could otherwise revive
// a deleted Peon.
export async function revokePeonCredentialsForFleetDeletion(
  workspaceId: string,
  peonId: string,
  removeRegistryRow = false,
  now = Date.now(),
): Promise<boolean> {
  return transactionWithAdvisoryLock(`peon-claim:revoke-peon:${peonId}`, async (tx) => {
    await tx.query(
      `UPDATE peon_credentials SET revoked_at=$3
       WHERE workspace_id=$1 AND bound_peon_id=$2 AND revoked_at IS NULL`,
      [workspaceId, peonId, now],
    );
    await tx.query(
      `UPDATE peon_claim_credentials SET state='revoked',revoked_at=$3
       WHERE workspace_id=$1 AND peon_id=$2 AND state<>'revoked'`,
      [workspaceId, peonId, now],
    );
    await tx.query(
      `UPDATE peon_claims SET state='cancelled',claim_token_hash=NULL,operator_code_hash=NULL,
       operator_code_key_version=NULL,operator_code_nonce=NULL,operator_code_ciphertext=NULL,
       operator_code_tag=NULL,terminal_at=$3
       WHERE peon_id=$1 AND (workspace_id=$2 OR workspace_id IS NULL)
         AND state IN ('pending','approved')`,
      [peonId, workspaceId, now],
    );
    await tx.query(
      `UPDATE peon_claim_attempts SET terminal_at=$2,tombstone_expires_at=$3
       WHERE claim_id IN (SELECT claim_id FROM peon_claims WHERE peon_id=$1 AND state='cancelled')`,
      [peonId, now, now + TOMBSTONE_MS],
    );
    await tx.query(
      `UPDATE peon_credential_rotations SET state='cancelled',terminal_at=$3,tombstone_expires_at=$4
       WHERE peon_id=$1 AND workspace_id=$2 AND state='pending_ack'`,
      [peonId, workspaceId, now, now + TOMBSTONE_MS],
    );
    await tx.query(
      `DELETE FROM peon_claim_deliveries WHERE peon_id=$1 AND workspace_id=$2`,
      [peonId, workspaceId],
    );
    await tx.query(`DELETE FROM peon_enrollment_leases WHERE peon_id=$1`, [peonId]);
    if (!removeRegistryRow) return true;
    const removed = await tx.query(
      `DELETE FROM peons WHERE peon_id=$1 AND workspace_id=$2`,
      [peonId, workspaceId],
    );
    return (removed.rowCount ?? 0) > 0;
  });
}

export async function revocationTargetExists(
  scope: "credential" | "peon",
  workspaceId: string,
  peonId: string,
  credentialId?: string,
): Promise<boolean> {
  if (scope === "credential") {
    return (await query(
      `SELECT 1 FROM peon_claim_credentials WHERE id=$1 AND peon_id=$2 AND workspace_id=$3`,
      [credentialId, peonId, workspaceId],
    )).rows.length > 0;
  }
  return (await query(
    `SELECT 1 FROM peon_identity_bindings WHERE peon_id=$1 AND workspace_id=$2 AND removed_at IS NULL`,
    [peonId, workspaceId],
  )).rows.length > 0;
}

export async function auditForbiddenRevocation(
  scope: "credential" | "peon",
  workspaceId: string,
  peonId: string,
  actorUserId: string,
  requestId: string,
  credentialId?: string,
): Promise<void> {
  await transaction(async (tx) => audit(tx, {
    workspaceId, peonId, credentialId, actorUserId, requestId, scope,
    event: `${scope}.revoke_denied`, outcome: "forbidden", stableCode: "FORBIDDEN",
  }));
}

export async function assertLegacyEnrollmentAllowed(peonId: string): Promise<void> {
  const lease = (await query<{ method: string }>(`SELECT method FROM peon_enrollment_leases WHERE peon_id=$1`, [peonId])).rows[0];
  const binding = (await query<{ method: string }>(
    `SELECT method FROM peon_identity_bindings WHERE peon_id=$1 AND removed_at IS NULL`,
    [peonId],
  )).rows[0];
  if (lease?.method === "claim" || binding?.method === "claim") throw claimError("ENROLLMENT_METHOD_LOCKED");
}

export async function bindLegacyCredentialWithClaimLock(
  workspaceId: string,
  credentialId: string,
  peonId: string,
  now = Date.now(),
): Promise<boolean> {
  let methodLocked = false;
  const bound = await transactionWithAdvisoryLock(`peon-claim:enrollment:${peonId}`, async (tx) => {
    const lease = (await tx.query<{ method: string }>(
      `SELECT method FROM peon_enrollment_leases WHERE peon_id=$1`,
      [peonId],
    )).rows[0];
    const binding = (await tx.query<{ method: string }>(
      `SELECT method FROM peon_identity_bindings WHERE peon_id=$1 AND removed_at IS NULL`,
      [peonId],
    )).rows[0];
    if (lease?.method === "claim" || binding?.method === "claim") {
      await tx.query(
        `UPDATE peon_credentials SET revoked_at=$3
         WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL`,
        [credentialId, workspaceId, now],
      );
      methodLocked = true;
      return false;
    }
    const result = await tx.query(
      `UPDATE peon_credentials SET bound_peon_id=$3
       WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL
         AND (bound_peon_id IS NULL OR bound_peon_id=$3)`,
      [credentialId, workspaceId, peonId],
    );
    if ((result.rowCount ?? 0) === 0) return false;
    await tx.query(
      `INSERT INTO peon_enrollment_leases
       (peon_id,identity_key_id,method,claim_id,created_at,expires_at)
       VALUES ($1,$2,'legacy',NULL,$3,NULL)
       ON CONFLICT (peon_id) DO NOTHING`,
      [peonId, `legacy:${peonId}`, now],
    );
    return true;
  });
  if (methodLocked) throw claimError("ENROLLMENT_METHOD_LOCKED");
  return bound;
}

async function pruneBounded(
  table: string,
  keyColumns: readonly string[],
  predicate: string,
  params: readonly unknown[],
): Promise<void> {
  const rows = (await query<Record<string, unknown>>(
    `SELECT ${keyColumns.join(",")} FROM ${table} WHERE ${predicate} LIMIT 500`,
    [...params],
  )).rows;
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const clauses = rows.map((row) => `(${keyColumns.map((column) => {
    values.push(row[column]);
    return `${column}=$${values.length}`;
  }).join(" AND ")})`);
  await query(`DELETE FROM ${table} WHERE ${clauses.join(" OR ")}`, values);
}

export async function cleanupPeonClaims(now = Date.now()): Promise<void> {
  const active = (await query<ClaimRow>(
    `SELECT * FROM peon_claims WHERE state IN ('pending','approved') ORDER BY created_at LIMIT 500`,
  )).rows;
  for (const row of active) await expireClaim(row, now);
  const rotations = (await query<RotationRow>(
    `SELECT * FROM peon_credential_rotations WHERE state='pending_ack' ORDER BY created_at LIMIT 500`,
  )).rows;
  for (const row of rotations) await expireRotation(row, now);
  const grace = (await query<{ peon_id: string; generation: number }>(
    `SELECT r.peon_id,c.generation
     FROM peon_credential_rotations r JOIN peon_claim_credentials c ON c.id=r.credential_id
     WHERE r.state='completed' AND r.old_socket_grace_ends_at<=$1
     ORDER BY r.old_socket_grace_ends_at LIMIT 500`,
    [now],
  )).rows;
  for (const item of grace) {
    evictPeonConnectionsBelowGeneration(item.peon_id, item.generation);
    evictPeonTransferConnectionsBelowGeneration(item.peon_id, item.generation);
  }
  await pruneBounded("peon_claim_request_nonces", ["identity_key_id", "request_nonce"], "expires_at<$1", [now]);
  await pruneBounded("peon_claim_ack_auth", ["claim_id"], "expires_at<$1", [now]);
  await pruneBounded(
    "peon_claim_rate_limits",
    ["scope", "subject_hash", "window_start"],
    "window_start<$1",
    [now - 86_400_000],
  );
  await pruneBounded(
    "peon_claim_attempts",
    ["attempt_id"],
    "tombstone_expires_at IS NOT NULL AND tombstone_expires_at<$1",
    [now],
  );
  await pruneBounded(
    "peon_credential_rotations",
    ["rotation_id"],
    "tombstone_expires_at IS NOT NULL AND tombstone_expires_at<$1",
    [now],
  );
  await pruneBounded("peon_claim_resolutions", ["claim_id", "user_id"], "expires_at<$1", [now]);
  await pruneBounded(
    "peon_claims",
    ["claim_id"],
    "terminal_at IS NOT NULL AND terminal_at<$1",
    [now - TERMINAL_RETENTION_MS],
  );
}

async function audit(
  tx: Transaction,
  input: {
    workspaceId?: string;
    peonId?: string;
    claimId?: string;
    credentialId?: string;
    actorUserId?: string;
    event: string;
    stableCode?: string;
    requestId?: string;
    scope?: "credential" | "peon";
    outcome?: "revoked" | "already_revoked" | "forbidden";
    revokedAt?: number;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO peon_claim_audit
     (id,workspace_id,peon_id,claim_id,credential_id,actor_user_id,event,stable_code,
      request_id,scope,outcome,revoked_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), input.workspaceId ?? null, input.peonId ?? null, input.claimId ?? null,
      input.credentialId ?? null, input.actorUserId ?? null, input.event, input.stableCode ?? null,
      input.requestId ?? null, input.scope ?? null, input.outcome ?? null, input.revokedAt ?? null, Date.now()],
  );
}

export async function resolvePc1Credential(bearer: string): Promise<{
  id: string;
  workspaceId: string;
  boundPeonId: string;
  generation: number;
  state: "active";
} | null> {
  if (!claimKeysConfigured()) return null;
  try {
    const credential = await credentialByBearer(bearer, ["active"]);
    return {
      id: credential.id, workspaceId: credential.workspace_id, boundPeonId: credential.peon_id,
      generation: credential.generation, state: "active",
    };
  } catch {
    return null;
  }
}
