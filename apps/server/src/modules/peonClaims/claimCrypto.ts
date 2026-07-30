import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPublicKey,
  createHash,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";
import { config } from "../../config.js";

export const CLAIM_PROTOCOL = 1;
export const CLAIM_CAPABILITY = "peon-claim-v1";
export const CLAIM_TTL_MS = 600_000;
export const DELIVERY_TTL_MS = 600_000;
export const OLD_SOCKET_GRACE_MS = 300_000;
export const CLOCK_SKEW_MS = 120_000;
export const POLL_AFTER_MS = 2_000;
export const MAX_BODY_BYTES = 16_384;
export const TERMINAL_RETENTION_MS = 86_400_000;
export const TOMBSTONE_MS = 604_800_000;
export const NONCE_RETENTION_MS = 86_400_000;

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface Proof {
  issuedAt: number;
  requestNonce: string;
  signature: string;
}

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface SignatureInput {
  serverOrigin: string;
  path: string;
  bindingNonce: string | null;
  body: Record<string, unknown>;
}

function decodeKey(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value ? decoded : null;
}

export function claimKeysConfigured(): boolean {
  if (!config.peonClaimEnabled) return false;
  const keys = [
    decodeKey(config.peonClaimCredentialPepper),
    decodeKey(config.peonClaimDeliveryKey),
    decodeKey(config.peonClaimOperatorCodeKey),
  ];
  return keys.every((key): key is Buffer => key !== null)
    && new Set(keys.map((key) => key.toString("base64url"))).size === keys.length;
}

function requireKey(value: string, label: string): Buffer {
  const key = decodeKey(value);
  if (!key) throw new Error(`${label} is not a canonical 32-byte base64url key`);
  return key;
}

// RFC 8785 uses ECMAScript primitive serialization and lexicographically sorted
// object keys. Protocol values are plain JSON (no bigint/undefined/non-finite).
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("value is not JSON");
}

export function sha256Base64url(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function semanticRequestHash(body: Record<string, unknown>, excluded: readonly string[]): string {
  const semantic = Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.includes(key)));
  return createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex");
}

export function identityKeyId(publicKey: PublicJwk): string {
  return `ed25519:${sha256Base64url(canonicalJson(publicKey))}`;
}

function bodyWithoutSignature(body: Record<string, unknown>): Record<string, unknown> {
  const proof = body.proof as Record<string, unknown>;
  return { ...body, proof: Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "signature")) };
}

export function verifyRequestProof(publicKey: PublicJwk, input: SignatureInput): boolean {
  const proof = input.body.proof as Proof;
  try {
    const signed = canonicalJson({
      capability: CLAIM_CAPABILITY,
      protocol: CLAIM_PROTOCOL,
      serverOrigin: input.serverOrigin,
      method: "POST",
      path: input.path,
      bindingNonce: input.bindingNonce,
      body: bodyWithoutSignature(input.body),
    });
    const signature = Buffer.from(proof.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== proof.signature) return false;
    return verify(null, Buffer.from(signed), createPublicKey({ key: publicKey as NodeJsonWebKey, format: "jwk" }), signature);
  } catch {
    return false;
  }
}

export function credentialVerifier(bearer: string): string {
  return createHmac("sha256", requireKey(config.peonClaimCredentialPepper, "credential pepper"))
    .update(bearer)
    .digest("base64url");
}

export function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintBearer(credentialId: string): string {
  return `pc1.${credentialId}.${randomBytes(32).toString("base64url")}`;
}

export function parseBearer(value: string): { credentialId: string } | null {
  const match = /^pc1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(value);
  if (!match) return null;
  const secret = Buffer.from(match[2], "base64url");
  return secret.length === 32 && secret.toString("base64url") === match[2] ? { credentialId: match[1].toLowerCase() } : null;
}

export interface DeliveryAad {
  protocol: 1;
  claimId?: string;
  rotationId?: string;
  credentialId: string;
  peonId: string;
  workspaceId: string;
  identityKeyId: string;
  generation: number;
}

function sealWithKey(
  plaintext: string,
  aad: unknown,
  key: string,
): { nonce: string; ciphertext: string; tag: string; keyVersion: 1 } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireKey(key, "sealing key"), nonce);
  cipher.setAAD(Buffer.from(canonicalJson(aad)));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), keyVersion: 1 };
}

function openWithKey(
  sealed: { nonce: string; ciphertext: string; tag: string; keyVersion: number },
  aad: unknown,
  key: string,
): string {
  if (sealed.keyVersion !== 1) throw new Error("unsupported delivery key version");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    requireKey(key, "sealing key"),
    Buffer.from(sealed.nonce, "base64url"),
  );
  decipher.setAAD(Buffer.from(canonicalJson(aad)));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sealBearer(bearer: string, aad: DeliveryAad) {
  return sealWithKey(bearer, aad, config.peonClaimDeliveryKey);
}

export function openBearer(sealed: { nonce: string; ciphertext: string; tag: string; keyVersion: number }, aad: DeliveryAad): string {
  return openWithKey(sealed, aad, config.peonClaimDeliveryKey);
}

export function sealOperatorCode(code: string, claimId: string, attemptId: string) {
  return sealWithKey(code, { protocol: 1, claimId, attemptId }, config.peonClaimOperatorCodeKey);
}

export function openOperatorCode(
  sealed: { nonce: string; ciphertext: string; tag: string; keyVersion: number },
  claimId: string,
  attemptId: string,
): string {
  return openWithKey(sealed, { protocol: 1, claimId, attemptId }, config.peonClaimOperatorCodeKey);
}

export function operatorCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let raw = "";
  for (let shift = 35n; shift >= 0n; shift -= 5n) raw += BASE32[Number((bits >> shift) & 31n)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function operatorCodeHash(code: string): string {
  return createHmac("sha256", requireKey(config.peonClaimCredentialPepper, "credential pepper"))
    .update(`operator-code-hash:${code}`)
    .digest("base64url");
}

export function subjectHash(scope: string, value: string): string {
  return createHmac("sha256", requireKey(config.peonClaimCredentialPepper, "credential pepper"))
    .update(`${scope}:${value}`)
    .digest("base64url");
}
