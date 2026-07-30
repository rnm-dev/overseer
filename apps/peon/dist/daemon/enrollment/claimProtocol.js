import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./claimIdentity.js";
export const CLAIM_CAPABILITY = "peon-claim-v1";
export const CLAIM_PROTOCOL = 1;
export const CLAIM_MAX_BODY_BYTES = 16 * 1024;
export const CLAIM_ERROR_CODES = [
    "BAD_REQUEST",
    "UNSUPPORTED_CAPABILITY",
    "UNSUPPORTED_PROTOCOL",
    "INVALID_IDENTITY",
    "BAD_SIGNATURE",
    "CLOCK_SKEW",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "REQUEST_REPLAYED",
    "ATTEMPT_ID_REUSED",
    "ATTEMPT_RETIRED",
    "ROTATION_ID_REUSED",
    "CLAIM_ACK_MISMATCH",
    "ROTATION_ACK_MISMATCH",
    "CLAIM_NOT_FOUND",
    "CLAIM_ALREADY_ACTIVE",
    "CLAIM_ALREADY_DECIDED",
    "CLAIM_DENIED",
    "CLAIM_CANCELLED",
    "CLAIM_EXPIRED",
    "CLAIM_CAPACITY_EXCEEDED",
    "IDENTITY_KEY_MISMATCH",
    "PEON_ALREADY_CLAIMED",
    "WORKSPACE_MISMATCH",
    "ENROLLMENT_METHOD_LOCKED",
    "CREDENTIAL_INVALID",
    "CREDENTIAL_REVOKED",
    "CREDENTIAL_RETIRED",
    "CREDENTIAL_GENERATION_MISMATCH",
    "ROTATION_ALREADY_ACTIVE",
    "ROTATION_EXPIRED",
    "RATE_LIMITED",
    "PERSIST_FAILED",
    "INTERNAL",
];
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const timestamp = z.number().int().nonnegative();
const credentialBearer = z.string().regex(/^pc1\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
const credentialDelivery = z.object({
    deliveryId: uuid,
    credentialId: uuid,
    generation: z.number().int().positive(),
    bearer: credentialBearer,
    expiresAt: timestamp,
}).strict();
export const claimCapabilitiesSchema = z.object({
    type: z.literal("claim_capabilities"),
    protocol: z.literal(1),
    capability: z.literal(CLAIM_CAPABILITY),
    transport: z.literal("https-short-poll"),
    pollAfterMs: z.literal(2000),
    claimTtlMs: z.literal(600000),
    deliveryTtlMs: z.literal(600000),
    clockSkewMs: z.literal(120000),
    maxBodyBytes: z.literal(16384),
    serverTime: timestamp,
}).strict();
export const claimCreatedSchema = z.object({
    type: z.literal("claim_created"),
    protocol: z.literal(1),
    claimId: uuid,
    operatorCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
    operatorUrl: z.string().max(320),
    state: z.literal("pending"),
    createdAt: timestamp,
    expiresAt: timestamp,
    pollAfterMs: z.literal(2000),
    serverTime: timestamp,
    replayed: z.boolean(),
}).strict();
const pendingStatus = z.object({
    type: z.literal("claim_status"),
    protocol: z.literal(1),
    claimId: uuid,
    state: z.literal("pending"),
    expiresAt: timestamp,
    pollAfterMs: z.literal(2000),
    serverTime: timestamp,
}).strict();
const approvedStatus = z.object({
    type: z.literal("claim_status"),
    protocol: z.literal(1),
    claimId: uuid,
    state: z.literal("approved"),
    mode: z.enum(["new", "recover"]),
    workspaceId: uuid,
    delivery: credentialDelivery,
    serverTime: timestamp,
    replayed: z.boolean(),
}).strict();
const terminalStatus = z.object({
    type: z.literal("claim_status"),
    protocol: z.literal(1),
    claimId: uuid,
    state: z.enum(["denied", "cancelled", "expired"]),
    code: z.enum(["CLAIM_DENIED", "CLAIM_CANCELLED", "CLAIM_EXPIRED"]),
    serverTime: timestamp,
}).strict().superRefine((value, context) => {
    const expected = {
        denied: "CLAIM_DENIED",
        cancelled: "CLAIM_CANCELLED",
        expired: "CLAIM_EXPIRED",
    }[value.state];
    if (value.code !== expected)
        context.addIssue({ code: "custom", message: "claim terminal state/code mismatch" });
});
export const claimStatusSchema = z.union([pendingStatus, approvedStatus, terminalStatus]);
export const claimCompletedSchema = z.object({
    type: z.literal("claim_completed"),
    protocol: z.literal(1),
    claimId: uuid,
    state: z.literal("completed"),
    peonId: uuid,
    workspaceId: uuid,
    credentialId: uuid,
    generation: z.number().int().positive(),
    completedAt: timestamp,
    serverTime: timestamp,
    replayed: z.boolean(),
}).strict();
export const claimCancelResultSchema = z.object({
    type: z.literal("claim_cancel_result"),
    protocol: z.literal(1),
    claimId: uuid,
    state: z.enum(["cancelled", "denied", "expired"]),
    code: z.enum(["CLAIM_CANCELLED", "CLAIM_DENIED", "CLAIM_EXPIRED"]),
    changed: z.boolean(),
    terminalAt: timestamp,
    serverTime: timestamp,
}).strict().superRefine((value, context) => {
    const expected = {
        cancelled: "CLAIM_CANCELLED",
        denied: "CLAIM_DENIED",
        expired: "CLAIM_EXPIRED",
    }[value.state];
    if (value.code !== expected)
        context.addIssue({ code: "custom", message: "claim cancel state/code mismatch" });
    if (value.changed !== (value.state === "cancelled")) {
        context.addIssue({ code: "custom", message: "claim cancel changed flag mismatch" });
    }
});
export const rotationDeliverySchema = z.object({
    type: z.literal("credential_rotation_delivery"),
    protocol: z.literal(1),
    rotationId: uuid,
    state: z.literal("pending_ack"),
    peonId: uuid,
    previousCredentialId: uuid,
    previousGeneration: z.number().int().positive(),
    delivery: credentialDelivery,
    serverTime: timestamp,
    replayed: z.boolean(),
}).strict();
export const rotationCompletedSchema = z.object({
    type: z.literal("credential_rotation_completed"),
    protocol: z.literal(1),
    rotationId: uuid,
    state: z.literal("completed"),
    peonId: uuid,
    credentialId: uuid,
    generation: z.number().int().min(2),
    previousCredentialId: uuid,
    oldSocketGraceEndsAt: timestamp,
    completedAt: timestamp,
    serverTime: timestamp,
    replayed: z.boolean(),
}).strict();
export const claimErrorSchema = z.object({
    type: z.literal("claim_error"),
    protocol: z.literal(1),
    code: z.enum(CLAIM_ERROR_CODES),
    message: z.string().min(1).max(240),
    serverTime: timestamp,
    retryAfterMs: z.number().int().positive().optional(),
    state: z.enum(["pending", "approved", "completed", "denied", "cancelled", "expired"]).optional(),
    claimId: uuid.optional(),
    expiresAt: timestamp.optional(),
}).strict();
export class ClaimHttpError extends Error {
    status;
    body;
    constructor(status, body, message) {
        super(message);
        this.status = status;
        this.body = body;
    }
}
export function canonicalServerOrigin(input) {
    let url;
    try {
        url = new URL(input);
    }
    catch {
        throw new Error("Overseer origin must be a complete URL");
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
        throw new Error("Overseer origin must not contain credentials, a path, query, or fragment");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("Overseer origin must use HTTPS (HTTP is allowed only on literal loopback)");
    }
    return url.origin;
}
export function requestNonce() {
    return randomBytes(16).toString("base64url");
}
export function signedBody(identity, serverOrigin, path, bindingNonce, body, now = Date.now()) {
    const proofWithoutSignature = { issuedAt: now, requestNonce: requestNonce() };
    const unsignedBody = { ...body, proof: proofWithoutSignature };
    const signatureInput = {
        capability: CLAIM_CAPABILITY,
        protocol: CLAIM_PROTOCOL,
        serverOrigin,
        method: "POST",
        path,
        bindingNonce,
        body: unsignedBody,
    };
    const signature = identity.sign(Buffer.from(canonicalJson(signatureInput)));
    return { ...body, proof: { ...proofWithoutSignature, signature } };
}
export async function readProtocolBody(response) {
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > CLAIM_MAX_BODY_BYTES)
        throw new Error("claim response exceeded 16 KiB");
    const text = await response.text();
    if (Buffer.byteLength(text) > CLAIM_MAX_BODY_BYTES)
        throw new Error("claim response exceeded 16 KiB");
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error("claim response was not valid JSON");
    }
}
