import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pairing } from "../pairing.js";
import { settings } from "../settings/index.js";
import { PeonIdentityStore, canonicalJson } from "./claimIdentity.js";
import { CLAIM_CAPABILITY, ClaimHttpError, canonicalServerOrigin, claimCapabilitiesSchema, claimCancelResultSchema, claimCompletedSchema, claimCreatedSchema, claimErrorSchema, claimStatusSchema, readProtocolBody, rotationCompletedSchema, rotationDeliverySchema, signedBody, } from "./claimProtocol.js";
import { EnrollmentStateStore, } from "./claimState.js";
const PACKAGE_VERSION = (() => {
    const value = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    return typeof value.version === "string" ? value.version : "unknown";
})();
const TRANSIENT_RETRY_MIN_MS = 1_000;
const TRANSIENT_RETRY_MAX_MS = 30_000;
function isActiveAttempt(attempt) {
    return Boolean(attempt && attempt.phase !== "terminal");
}
class ClaimTransportError extends Error {
}
class ClaimPersistenceError extends Error {
}
function semanticHash(body, excluded) {
    const semantic = { ...body };
    for (const key of excluded)
        delete semantic[key];
    return createHash("sha256").update(canonicalJson(semantic)).digest("hex");
}
function displayMetadata(current) {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    if (!["darwin", "linux", "windows"].includes(platform))
        throw new Error(`unsupported claim platform: ${platform}`);
    if (!["arm64", "x64"].includes(process.arch))
        throw new Error(`unsupported claim architecture: ${process.arch}`);
    return {
        name: [...(current.name.trim() || "Peon")].slice(0, 120).join(""),
        platform,
        architecture: process.arch,
        daemonVersion: PACKAGE_VERSION,
    };
}
export class PeonClaimClient {
    stateStore;
    identityStore;
    settingsSource;
    pairingSource;
    fetchImpl;
    now;
    random;
    scheduling;
    onTimerScheduled;
    timer = null;
    running = false;
    started = false;
    transientFailures = 0;
    lastLegacyArm = null;
    constructor(options = {}) {
        this.stateStore = options.stateStore ?? new EnrollmentStateStore();
        this.identityStore = options.identityStore ?? new PeonIdentityStore();
        this.settingsSource = options.settings ?? settings;
        this.pairingSource = options.pairing ?? pairing;
        this.fetchImpl = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.scheduling = options.schedule ?? true;
        this.onTimerScheduled = options.onTimerScheduled;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.reconcileIdentity();
        if (this.hasPendingWork())
            this.kick();
    }
    stop() {
        this.started = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    async begin(serverOriginInput) {
        const serverOrigin = canonicalServerOrigin(serverOriginInput);
        const currentState = this.stateStore.get();
        if (isActiveAttempt(currentState.attempt)) {
            if (currentState.attempt.serverOrigin !== serverOrigin) {
                throw new ClaimHttpError(409, null, "ENROLLMENT_METHOD_LOCKED");
            }
            if (currentState.attempt.mode === "probe") {
                this.lastLegacyArm = null;
                await this.runOnce();
                return this.statusWithLegacyArm();
            }
            return this.getStatus();
        }
        if (currentState.rotation)
            throw new ClaimHttpError(409, null, "credential rotation is active");
        const identity = this.ensureIdentity();
        const attemptId = randomUUID();
        const now = this.now();
        this.stateStore.replace({
            ...currentState,
            identity: {
                peonId: identity.peonId,
                identityKeyId: identity.identityKeyId,
                publicKey: identity.publicKey,
            },
            attempt: {
                attemptId,
                mode: "probe",
                phase: "probing",
                serverOrigin,
                createdAt: now,
                updatedAt: now,
            },
            pendingCredential: undefined,
        });
        this.lastLegacyArm = null;
        await this.runOnce();
        return this.statusWithLegacyArm();
    }
    armLegacy() {
        const state = this.stateStore.get();
        if (isActiveAttempt(state.attempt) && state.attempt.mode !== "legacy") {
            throw new ClaimHttpError(409, null, "ENROLLMENT_METHOD_LOCKED");
        }
        const armed = this.pairingSource.arm();
        const now = this.now();
        this.stateStore.replace({
            ...state,
            attempt: {
                attemptId: state.attempt?.mode === "legacy" ? state.attempt.attemptId : randomUUID(),
                mode: "legacy",
                phase: "polling",
                serverOrigin: state.attempt?.serverOrigin ?? "",
                createdAt: state.attempt?.createdAt ?? now,
                updatedAt: now,
                expiresAt: armed.expiresAt,
            },
        });
        return { ...armed, status: this.getStatus() };
    }
    legacyEnrollmentAllowed(serverOrigin) {
        const state = this.syncLegacyExpiry();
        const attempt = state.attempt;
        if (!attempt || attempt.mode !== "legacy" || attempt.phase === "terminal" || !this.pairingSource.isArmed())
            return false;
        return !attempt.serverOrigin || !serverOrigin || canonicalServerOrigin(serverOrigin) === attempt.serverOrigin;
    }
    legacyEnrollmentBlocked() {
        const attempt = this.syncLegacyExpiry().attempt;
        return Boolean(attempt && attempt.phase !== "terminal" && attempt.mode !== "legacy");
    }
    completeLegacyEnrollment() {
        this.stateStore.update((state) => ({
            ...state,
            attempt: state.attempt?.mode === "legacy"
                ? {
                    attemptId: state.attempt.attemptId,
                    mode: "legacy",
                    phase: "terminal",
                    serverOrigin: state.attempt.serverOrigin,
                    createdAt: state.attempt.createdAt,
                    updatedAt: this.now(),
                    terminalState: "completed",
                }
                : state.attempt,
        }));
    }
    async cancel() {
        const state = this.stateStore.get();
        const attempt = state.attempt;
        if (!attempt || attempt.phase === "terminal")
            return this.getStatus();
        if (attempt.phase === "parked") {
            if (state.pendingCredential)
                return this.getStatus();
            this.finishAttempt("cancelled", "CLAIM_CANCELLED");
            return this.getStatus();
        }
        if (state.pendingCredential && attempt.cancelRequested) {
            await this.ackClaim(state);
            return this.getStatus();
        }
        if (attempt.mode === "legacy") {
            this.pairingSource.burn();
            this.finishAttempt("cancelled", "CLAIM_CANCELLED");
            return this.getStatus();
        }
        if (attempt.mode === "probe" || !attempt.claimId || !attempt.claimNonce || !attempt.claimToken) {
            this.finishAttempt("cancelled", "CLAIM_CANCELLED");
            return this.getStatus();
        }
        const path = `/api/v1/peon-claims/${attempt.claimId}/cancel`;
        const body = signedBody(this.ensureIdentity(), attempt.serverOrigin, path, attempt.claimNonce, {
            type: "claim_cancel",
            protocol: 1,
            claimId: attempt.claimId,
        }, this.signedNow(attempt.serverClockOffsetMs));
        this.stateStore.update((current) => ({
            ...current,
            attempt: {
                ...current.attempt,
                cancelRequested: true,
                updatedAt: this.now(),
            },
        }));
        try {
            const response = await this.post(attempt.serverOrigin, path, body, attempt.claimToken, attempt.claimId);
            const cancelled = claimCancelResultSchema.parse(response);
            if (cancelled.claimId !== attempt.claimId)
                throw new Error("claim cancel result did not match the durable claim");
            if (this.stateStore.get().pendingCredential) {
                this.beginCandidateReconciliation(cancelled.code);
            }
            else {
                this.finishAttempt(cancelled.state, cancelled.code);
            }
        }
        catch (error) {
            if (this.stateStore.get().pendingCredential) {
                this.beginCandidateReconciliation(error instanceof ClaimHttpError ? error.body?.code ?? `HTTP_${error.status}` : "TRANSPORT");
                if (error instanceof ClaimHttpError && error.status === 401)
                    return this.getStatus();
            }
            throw error;
        }
        return this.getStatus();
    }
    resumeParked() {
        const state = this.stateStore.get();
        if (state.attempt?.phase !== "parked" && state.rotation?.phase !== "parked") {
            return this.getStatus();
        }
        this.stateStore.update((current) => ({
            ...current,
            attempt: current.attempt?.phase === "parked"
                ? {
                    ...current.attempt,
                    phase: current.pendingCredential
                        ? (current.attempt.cancelRequested ? "reconciling" : "acknowledging")
                        : current.attempt.mode === "probe"
                            ? "probing"
                            : current.attempt.claimId
                                ? "polling"
                                : "starting",
                    lastErrorCode: undefined,
                    retryAt: this.now(),
                    updatedAt: this.now(),
                }
                : current.attempt,
            rotation: current.rotation?.phase === "parked"
                ? {
                    ...current.rotation,
                    phase: current.pendingCredential ? "acknowledging" : "starting",
                    lastErrorCode: undefined,
                    retryAt: this.now(),
                    updatedAt: this.now(),
                }
                : current.rotation,
        }));
        this.kick();
        return this.getStatus();
    }
    async rotate() {
        const state = this.stateStore.get();
        const active = state.credential;
        const bearer = this.settingsSource.get().overseerToken.trim();
        if (!active || active.state !== "active" || !bearer.startsWith("pc1.")) {
            throw new ClaimHttpError(409, null, "an active peon-claim-v1 credential is required");
        }
        if (state.rotation) {
            await this.runOnce();
            return this.getStatus();
        }
        if (isActiveAttempt(state.attempt))
            throw new ClaimHttpError(409, null, "enrollment is active");
        this.ensureIdentity();
        const rotationId = randomUUID();
        const startSemantic = {
            type: "credential_rotation_start",
            protocol: 1,
            capability: CLAIM_CAPABILITY,
            rotationId,
            peonId: active.peonId,
            identityKeyId: active.identityKeyId,
            currentCredentialId: active.credentialId,
            currentGeneration: active.generation,
            serverOrigin: active.serverOrigin,
        };
        this.stateStore.update((current) => ({
            ...current,
            rotation: {
                rotationId,
                phase: "starting",
                createdAt: this.now(),
                updatedAt: this.now(),
                requestHash: semanticHash(startSemantic, ["rotationId"]),
                startSemantic,
                serverClockOffsetMs: active.serverClockOffsetMs,
            },
        }));
        await this.runOnce();
        return this.getStatus();
    }
    getStatus() {
        const state = this.syncLegacyExpiry();
        const attempt = state.attempt;
        const credential = state.credential;
        return {
            mode: !attempt ? "idle" : attempt.mode === "legacy" ? "legacy" : "claim",
            state: attempt?.phase === "terminal" ? attempt.terminalState ?? "terminal" : attempt?.phase ?? "idle",
            ...(attempt?.serverOrigin ? { serverOrigin: attempt.serverOrigin } : {}),
            ...(attempt?.claimId ? { claimId: attempt.claimId } : {}),
            ...(attempt?.operatorCode ? { operatorCode: attempt.operatorCode } : {}),
            ...(attempt?.operatorUrl ? { operatorUrl: attempt.operatorUrl } : {}),
            ...(attempt?.expiresAt ? { expiresAt: attempt.expiresAt } : {}),
            ...(attempt?.lastErrorCode ? { lastErrorCode: attempt.lastErrorCode } : {}),
            ...(credential ? {
                credential: {
                    credentialId: credential.credentialId,
                    generation: credential.generation,
                    state: credential.state,
                },
            } : {}),
            ...(state.rotation ? {
                rotation: {
                    rotationId: state.rotation.rotationId,
                    state: state.rotation.phase,
                    ...(state.rotation.lastErrorCode ? { lastErrorCode: state.rotation.lastErrorCode } : {}),
                },
            } : {}),
        };
    }
    statusWithLegacyArm() {
        const armed = this.lastLegacyArm;
        return {
            ...this.getStatus(),
            ...(armed ? { legacyPhrase: armed.phrase, legacyExpiresAt: armed.expiresAt } : {}),
        };
    }
    getSocketCredentialOverride() {
        const state = this.stateStore.get();
        const attempt = state.attempt;
        const pending = state.pendingCredential;
        if (!attempt?.awaitingSocketConfirmation || attempt.phase !== "reconciling" || !pending)
            return null;
        return {
            overseerUrl: pending.serverOrigin,
            overseerToken: pending.bearer,
            peonId: pending.peonId,
        };
    }
    confirmCandidateFromSocket(authenticatedBearer, peonId) {
        const state = this.stateStore.get();
        const pending = state.pendingCredential;
        const attempt = state.attempt;
        if (!pending || !attempt?.awaitingSocketConfirmation || attempt.phase !== "reconciling")
            return false;
        if (authenticatedBearer !== pending.bearer || peonId !== pending.peonId)
            return false;
        this.installCredential(pending);
        this.completeClaim(pending);
        return true;
    }
    recordCredentialRejection(rejectedBearer, code) {
        if (!["CREDENTIAL_REVOKED", "CREDENTIAL_INVALID", "CREDENTIAL_RETIRED"].includes(code))
            return;
        const state = this.stateStore.get();
        if (state.pendingCredential?.bearer === rejectedBearer) {
            if (state.attempt && state.attempt.phase !== "terminal") {
                this.discardRevokedCandidate(state.attempt.cancelRequested ? "cancelled" : "expired");
            }
            else if (state.rotation) {
                this.stateStore.update((current) => ({
                    ...current,
                    pendingCredential: undefined,
                    rotation: undefined,
                }));
            }
            return;
        }
        if (this.settingsSource.get().overseerToken !== rejectedBearer)
            return;
        if (state.pendingCredential) {
            // A recovery/rotation candidate is the reconciliation authority. A
            // terminal verdict for the previously installed bearer must fence that
            // bearer without deleting the candidate that may already have won ACK.
            this.settingsSource.update({ overseerToken: "" });
            this.stateStore.update((current) => ({
                ...current,
                attempt: current.attempt && current.attempt.phase !== "terminal"
                    ? { ...current.attempt, lastErrorCode: code, retryAt: this.now(), updatedAt: this.now() }
                    : current.attempt,
                rotation: current.rotation
                    ? { ...current.rotation, lastErrorCode: code, retryAt: this.now(), updatedAt: this.now() }
                    : current.rotation,
            }));
            this.kick();
            return;
        }
        this.settingsSource.update({ overseerToken: "" });
        this.stateStore.update((state) => ({
            ...state,
            credential: state.credential ? { ...state.credential, state: "revoked" } : undefined,
            rotation: undefined,
            pendingCredential: undefined,
        }));
    }
    async runOnce() {
        if (this.running)
            return;
        this.running = true;
        try {
            const state = this.stateStore.get();
            if (state.rotation && state.rotation.phase !== "parked") {
                await this.advanceRotation(state);
            }
            else if (state.attempt?.mode === "probe"
                && state.attempt.phase !== "terminal"
                && state.attempt.phase !== "parked") {
                await this.advanceProbe(state);
                const selected = this.stateStore.get();
                if (selected.attempt?.mode === "claim" && selected.attempt.phase === "starting") {
                    await this.advanceClaim(selected);
                }
            }
            else if (state.attempt?.mode === "claim"
                && state.attempt.phase !== "terminal"
                && state.attempt.phase !== "parked") {
                await this.advanceClaim(state);
            }
            this.transientFailures = 0;
        }
        catch (error) {
            this.transientFailures += 1;
            this.recordFailure(error);
            throw error;
        }
        finally {
            this.running = false;
            if (this.started && this.hasPendingWork())
                this.scheduleNext();
        }
    }
    async probe(serverOrigin) {
        let response;
        try {
            response = await this.fetchImpl(`${serverOrigin}/api/v1/peon-claims/capabilities`, {
                method: "GET",
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
                headers: { Accept: "application/json" },
            });
        }
        catch (error) {
            throw new ClaimTransportError("claim capability transport failed", { cause: error });
        }
        if (response.status >= 300 && response.status < 400)
            throw new Error("claim capability probe redirected");
        if (response.status === 404)
            return false;
        const body = await readProtocolBody(response);
        if (!response.ok) {
            const parsed = claimErrorSchema.safeParse(body);
            if (response.status === 400 && parsed.success && parsed.data.code === "UNSUPPORTED_CAPABILITY")
                return false;
            throw new ClaimHttpError(response.status, parsed.success ? parsed.data : null, "claim capability probe failed");
        }
        return claimCapabilitiesSchema.parse(body);
    }
    async advanceProbe(state) {
        const attempt = state.attempt;
        if (!attempt || attempt.mode !== "probe")
            throw new Error("incomplete durable capability probe");
        const capability = await this.probe(attempt.serverOrigin);
        if (!capability) {
            const armed = this.pairingSource.arm();
            this.lastLegacyArm = armed;
            this.stateStore.update((current) => ({
                ...current,
                attempt: {
                    ...current.attempt,
                    mode: "legacy",
                    phase: "polling",
                    updatedAt: this.now(),
                    expiresAt: armed.expiresAt,
                    lastErrorCode: undefined,
                    retryAt: undefined,
                },
            }));
            return;
        }
        const identity = this.ensureIdentity();
        const claimNonce = randomBytes(32).toString("base64url");
        const claimToken = randomBytes(32).toString("base64url");
        const startSemantic = {
            type: "claim_start",
            protocol: 1,
            capability: CLAIM_CAPABILITY,
            attemptId: attempt.attemptId,
            peonId: identity.peonId,
            serverOrigin: attempt.serverOrigin,
            claimNonce,
            claimTokenHash: createHash("sha256").update(Buffer.from(claimToken, "base64url")).digest("base64url"),
            identity: {
                algorithm: "Ed25519",
                keyId: identity.identityKeyId,
                publicKey: identity.publicKey,
            },
            display: displayMetadata(this.settingsSource.get()),
        };
        this.stateStore.update((current) => ({
            ...current,
            attempt: {
                ...current.attempt,
                mode: "claim",
                phase: "starting",
                claimNonce,
                claimToken,
                requestHash: semanticHash(startSemantic, ["attemptId"]),
                startSemantic,
                serverClockOffsetMs: capability.serverTime - this.now(),
                updatedAt: this.now(),
                lastErrorCode: undefined,
                retryAt: undefined,
            },
        }));
    }
    async advanceClaim(state) {
        const attempt = state.attempt;
        if (attempt.phase === "starting") {
            if (!attempt.startSemantic || !attempt.claimToken || !attempt.claimNonce)
                throw new Error("incomplete durable claim start");
            if (semanticHash(attempt.startSemantic, ["attemptId"]) !== attempt.requestHash) {
                throw new Error("durable claim semantic hash mismatch");
            }
            try {
                const request = signedBody(this.ensureIdentity(), attempt.serverOrigin, "/api/v1/peon-claims", attempt.claimNonce, attempt.startSemantic, this.signedNow(attempt.serverClockOffsetMs));
                const response = await this.post(attempt.serverOrigin, "/api/v1/peon-claims", request);
                const created = claimCreatedSchema.parse(response);
                if (new URL(created.operatorUrl).origin !== attempt.serverOrigin
                    || created.operatorUrl !== `${attempt.serverOrigin}/claim/${created.operatorCode}`) {
                    throw new Error("claim operator URL did not match the configured Overseer origin");
                }
                this.stateStore.update((current) => ({
                    ...current,
                    attempt: {
                        ...current.attempt,
                        phase: "polling",
                        claimId: created.claimId,
                        operatorCode: created.operatorCode,
                        operatorUrl: created.operatorUrl,
                        expiresAt: created.expiresAt,
                        pollAfterMs: created.pollAfterMs,
                        updatedAt: this.now(),
                        lastErrorCode: undefined,
                        retryAt: undefined,
                    },
                }));
                return;
            }
            catch (error) {
                if (error instanceof ClaimHttpError && error.body?.code === "CLOCK_SKEW") {
                    const serverTime = error.body.serverTime;
                    this.stateStore.update((current) => ({
                        ...current,
                        attempt: {
                            ...current.attempt,
                            serverClockOffsetMs: serverTime - this.now(),
                            updatedAt: this.now(),
                        },
                    }));
                }
                throw error;
            }
        }
        if (attempt.phase === "approved" || attempt.phase === "acknowledging" || attempt.phase === "reconciling") {
            await this.ackClaim(state);
            return;
        }
        if (attempt.phase !== "polling" || !attempt.claimId || !attempt.claimNonce || !attempt.claimToken) {
            throw new Error("incomplete durable claim poll");
        }
        const path = `/api/v1/peon-claims/${attempt.claimId}/poll`;
        const body = signedBody(this.ensureIdentity(), attempt.serverOrigin, path, attempt.claimNonce, {
            type: "claim_poll",
            protocol: 1,
            claimId: attempt.claimId,
        }, this.signedNow(attempt.serverClockOffsetMs));
        const response = await this.post(attempt.serverOrigin, path, body, attempt.claimToken, attempt.claimId);
        const status = claimStatusSchema.parse(response);
        if (status.claimId !== attempt.claimId) {
            throw new Error("claim status did not match the polled claim");
        }
        if (status.state === "pending") {
            this.stateStore.update((current) => ({
                ...current,
                attempt: {
                    ...current.attempt,
                    expiresAt: status.expiresAt,
                    pollAfterMs: status.pollAfterMs,
                    retryAt: this.now() + status.pollAfterMs + Math.floor(this.random() * 501),
                    updatedAt: this.now(),
                    lastErrorCode: undefined,
                },
            }));
            return;
        }
        if (status.state !== "approved") {
            this.finishAttempt(status.state, status.code);
            return;
        }
        const identity = this.ensureIdentity();
        if (status.mode === "new" && status.delivery.generation !== 1) {
            throw new Error("new enrollment credential generation was inconsistent");
        }
        const previous = state.credential;
        if (status.mode === "recover" && previous && (status.workspaceId !== previous.workspaceId
            || identity.peonId !== previous.peonId
            || identity.identityKeyId !== previous.identityKeyId
            || status.delivery.generation <= previous.generation)) {
            throw new Error("recovery credential did not advance the bound credential generation");
        }
        this.assertDeliveredCredential(status.delivery.bearer, status.delivery.credentialId, status.delivery.generation);
        const pending = {
            serverOrigin: attempt.serverOrigin,
            peonId: identity.peonId,
            identityKeyId: identity.identityKeyId,
            workspaceId: status.workspaceId,
            credentialId: status.delivery.credentialId,
            generation: status.delivery.generation,
            state: "pending",
            bearer: status.delivery.bearer,
            deliveryId: status.delivery.deliveryId,
            expiresAt: status.delivery.expiresAt,
            serverClockOffsetMs: attempt.serverClockOffsetMs,
        };
        const ackSemantic = {
            type: "claim_ack",
            protocol: 1,
            claimId: attempt.claimId,
            deliveryId: pending.deliveryId,
            credentialId: pending.credentialId,
            generation: pending.generation,
        };
        this.stateStore.update((current) => ({
            ...current,
            pendingCredential: pending,
            attempt: {
                ...current.attempt,
                phase: "approved",
                ackRequestHash: semanticHash(ackSemantic, []),
                updatedAt: this.now(),
                lastErrorCode: undefined,
                retryAt: undefined,
            },
        }));
    }
    async ackClaim(state) {
        const attempt = state.attempt;
        const pending = state.pendingCredential;
        if (!attempt.claimId || !attempt.claimNonce || !pending)
            throw new Error("incomplete durable claim acknowledgement");
        if (attempt.awaitingSocketConfirmation)
            return;
        this.stateStore.update((current) => ({
            ...current,
            attempt: {
                ...current.attempt,
                phase: current.attempt.cancelRequested ? "reconciling" : "acknowledging",
                updatedAt: this.now(),
            },
        }));
        const path = `/api/v1/peon-claims/${attempt.claimId}/ack`;
        const ackSemantic = {
            type: "claim_ack",
            protocol: 1,
            claimId: attempt.claimId,
            deliveryId: pending.deliveryId,
            credentialId: pending.credentialId,
            generation: pending.generation,
        };
        const hash = semanticHash(ackSemantic, []);
        if (attempt.ackRequestHash && attempt.ackRequestHash !== hash) {
            throw new Error("durable claim acknowledgement semantic hash mismatch");
        }
        const body = signedBody(this.ensureIdentity(), attempt.serverOrigin, path, attempt.claimNonce, ackSemantic, this.signedNow(attempt.serverClockOffsetMs));
        try {
            const response = await this.post(attempt.serverOrigin, path, body, pending.bearer, attempt.claimId);
            const completed = claimCompletedSchema.parse(response);
            this.assertCompletion(completed, pending, attempt.claimId);
            this.installCredential(pending);
            this.completeClaim(pending);
        }
        catch (error) {
            if (error instanceof ClaimHttpError && error.body?.code === "CREDENTIAL_REVOKED") {
                this.discardRevokedCandidate(attempt.cancelRequested ? "cancelled" : "expired");
                return;
            }
            if (error instanceof ClaimHttpError && error.body?.code === "CLAIM_NOT_FOUND") {
                this.stateStore.update((current) => ({
                    ...current,
                    attempt: {
                        ...current.attempt,
                        phase: "reconciling",
                        awaitingSocketConfirmation: true,
                        lastErrorCode: "CLAIM_NOT_FOUND",
                        retryAt: undefined,
                        updatedAt: this.now(),
                    },
                }));
                // Notify socket supervisors without installing the candidate into the
                // registrar/update HTTP credential path. Only a control hello_ack may
                // promote it after ACK-result retention has elapsed.
                this.settingsSource.update({});
                return;
            }
            throw error;
        }
    }
    async advanceRotation(state) {
        const rotation = state.rotation;
        const active = state.credential;
        if (!active || active.state !== "active")
            throw new Error("rotation lost its active credential");
        if (rotation.phase === "acknowledging" && state.pendingCredential) {
            await this.ackRotation(state);
            return;
        }
        const oldBearer = this.settingsSource.get().overseerToken.trim();
        if (!oldBearer)
            throw new Error("rotation lost its active bearer");
        if (semanticHash(rotation.startSemantic, ["rotationId"]) !== rotation.requestHash) {
            throw new Error("durable rotation semantic hash mismatch");
        }
        let response;
        try {
            const request = signedBody(this.ensureIdentity(), active.serverOrigin, "/api/v1/peon-credentials/rotations", null, rotation.startSemantic, this.signedNow(rotation.serverClockOffsetMs ?? active.serverClockOffsetMs));
            response = await this.post(active.serverOrigin, "/api/v1/peon-credentials/rotations", request, oldBearer);
        }
        catch (error) {
            if (error instanceof ClaimHttpError && error.body?.code === "CLOCK_SKEW") {
                this.stateStore.update((current) => ({
                    ...current,
                    rotation: {
                        ...current.rotation,
                        serverClockOffsetMs: error.body.serverTime - this.now(),
                        updatedAt: this.now(),
                    },
                }));
            }
            throw error;
        }
        const delivery = rotationDeliverySchema.parse(response);
        if (delivery.rotationId !== rotation.rotationId
            || delivery.peonId !== active.peonId
            || delivery.previousCredentialId !== active.credentialId
            || delivery.previousGeneration !== active.generation
            || delivery.delivery.generation !== active.generation + 1) {
            throw new Error("rotation delivery did not match the active credential generation");
        }
        this.assertDeliveredCredential(delivery.delivery.bearer, delivery.delivery.credentialId, delivery.delivery.generation, active.generation + 1);
        const pending = {
            ...active,
            credentialId: delivery.delivery.credentialId,
            generation: delivery.delivery.generation,
            bearer: delivery.delivery.bearer,
            deliveryId: delivery.delivery.deliveryId,
            expiresAt: delivery.delivery.expiresAt,
            state: "pending",
        };
        const ackSemantic = {
            type: "credential_rotation_ack",
            protocol: 1,
            rotationId: rotation.rotationId,
            deliveryId: pending.deliveryId,
            credentialId: pending.credentialId,
            generation: pending.generation,
        };
        this.stateStore.update((current) => ({
            ...current,
            pendingCredential: pending,
            rotation: {
                ...current.rotation,
                phase: "acknowledging",
                ackRequestHash: semanticHash(ackSemantic, []),
                updatedAt: this.now(),
                lastErrorCode: undefined,
                retryAt: undefined,
            },
        }));
    }
    async ackRotation(state) {
        const rotation = state.rotation;
        const pending = state.pendingCredential;
        const active = state.credential;
        const path = `/api/v1/peon-credentials/rotations/${rotation.rotationId}/ack`;
        const ackSemantic = {
            type: "credential_rotation_ack",
            protocol: 1,
            rotationId: rotation.rotationId,
            deliveryId: pending.deliveryId,
            credentialId: pending.credentialId,
            generation: pending.generation,
        };
        const hash = semanticHash(ackSemantic, []);
        if (rotation.ackRequestHash && rotation.ackRequestHash !== hash) {
            throw new Error("durable rotation acknowledgement semantic hash mismatch");
        }
        const body = signedBody(this.ensureIdentity(), active.serverOrigin, path, null, ackSemantic, this.signedNow(rotation.serverClockOffsetMs ?? active.serverClockOffsetMs));
        const response = await this.post(active.serverOrigin, path, body, pending.bearer);
        const completed = rotationCompletedSchema.parse(response);
        if (completed.rotationId !== rotation.rotationId
            || completed.peonId !== active.peonId
            || completed.previousCredentialId !== active.credentialId
            || completed.credentialId !== pending.credentialId
            || completed.generation !== pending.generation) {
            throw new Error("rotation completion did not match the persisted delivery");
        }
        this.installCredential(pending);
        this.stateStore.update((current) => ({
            ...current,
            credential: this.activeMetadata(pending),
            pendingCredential: undefined,
            rotation: undefined,
        }));
    }
    async post(serverOrigin, path, body, bearer, expectedClaimId) {
        const encoded = JSON.stringify(body);
        if (Buffer.byteLength(encoded) > 16 * 1024)
            throw new Error("claim request exceeded 16 KiB");
        let response;
        try {
            response = await this.fetchImpl(`${serverOrigin}${path}`, {
                method: "POST",
                redirect: "manual",
                signal: AbortSignal.timeout(10_000),
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
                },
                body: encoded,
            });
        }
        catch (error) {
            throw new ClaimTransportError("claim request transport failed", { cause: error });
        }
        if (response.status >= 300 && response.status < 400)
            throw new Error("claim request redirected");
        const parsed = await readProtocolBody(response);
        if (!response.ok) {
            const error = claimErrorSchema.safeParse(parsed);
            if (error.success && expectedClaimId && error.data.claimId
                && error.data.claimId !== expectedClaimId) {
                throw new Error("claim error did not match the requested claim");
            }
            throw new ClaimHttpError(response.status, error.success ? error.data : null, "claim request failed");
        }
        return parsed;
    }
    ensureIdentity() {
        const existingIdentityPeonId = this.identityStore.existingPeonId();
        const configuredPeonId = this.settingsSource.get().peonId.trim();
        if (existingIdentityPeonId && !configuredPeonId)
            this.settingsSource.update({ peonId: existingIdentityPeonId });
        if (existingIdentityPeonId && configuredPeonId && existingIdentityPeonId !== configuredPeonId) {
            throw new Error("configured peonId does not match the stable identity key");
        }
        const peonId = existingIdentityPeonId ?? (configuredPeonId || randomUUID());
        if (!configuredPeonId)
            this.settingsSource.update({ peonId });
        const identity = this.identityStore.ensure(peonId);
        const state = this.stateStore.get();
        if (state.identity && (state.identity.peonId !== identity.peonId || state.identity.identityKeyId !== identity.identityKeyId)) {
            throw new Error("durable enrollment identity does not match the stable identity key");
        }
        if (!state.identity) {
            this.stateStore.update((current) => ({
                ...current,
                identity: {
                    peonId: identity.peonId,
                    identityKeyId: identity.identityKeyId,
                    publicKey: identity.publicKey,
                },
            }));
        }
        return identity;
    }
    reconcileIdentity() {
        const identityPeonId = this.identityStore.existingPeonId();
        if (identityPeonId && !this.settingsSource.get().peonId.trim()) {
            this.settingsSource.update({ peonId: identityPeonId });
        }
        const state = this.stateStore.get();
        if (state.pendingCredential && !state.attempt && !state.rotation) {
            throw new Error("orphaned pending enrollment credential");
        }
    }
    assertCompletion(completed, pending, claimId) {
        if (completed.claimId !== claimId
            || completed.peonId !== pending.peonId
            || completed.workspaceId !== pending.workspaceId
            || completed.credentialId !== pending.credentialId
            || completed.generation !== pending.generation) {
            throw new Error("claim completion did not match the persisted credential delivery");
        }
    }
    assertDeliveredCredential(bearer, credentialId, generation, expectedGeneration = generation) {
        if (bearer.split(".")[1] !== credentialId
            || generation !== expectedGeneration
            || generation < 1) {
            throw new Error("credential delivery identity or generation was inconsistent");
        }
    }
    installCredential(pending) {
        try {
            const committed = this.settingsSource.update({
                overseerUrl: pending.serverOrigin,
                overseerToken: pending.bearer,
                peonId: pending.peonId,
            });
            if (committed.overseerUrl !== pending.serverOrigin
                || committed.overseerToken !== pending.bearer
                || committed.peonId !== pending.peonId) {
                throw new Error("active credential settings verification failed");
            }
            this.pairingSource.burn();
        }
        catch (error) {
            throw new ClaimPersistenceError("active credential settings were not durably committed", { cause: error });
        }
    }
    activeMetadata(pending) {
        const { bearer: _bearer, deliveryId: _deliveryId, expiresAt: _expiresAt, state: _state, ...metadata } = pending;
        return { ...metadata, state: "active" };
    }
    completeClaim(pending) {
        this.stateStore.update((current) => ({
            ...current,
            credential: this.activeMetadata(pending),
            pendingCredential: undefined,
            attempt: current.attempt
                ? {
                    attemptId: current.attempt.attemptId,
                    mode: "claim",
                    phase: "terminal",
                    serverOrigin: current.attempt.serverOrigin,
                    createdAt: current.attempt.createdAt,
                    updatedAt: this.now(),
                    ...(current.attempt.claimId ? { claimId: current.attempt.claimId } : {}),
                    terminalState: "completed",
                }
                : undefined,
        }));
    }
    beginCandidateReconciliation(lastErrorCode) {
        this.stateStore.update((state) => ({
            ...state,
            attempt: state.attempt
                ? {
                    ...state.attempt,
                    phase: "reconciling",
                    cancelRequested: true,
                    awaitingSocketConfirmation: false,
                    ...(lastErrorCode ? { lastErrorCode } : {}),
                    retryAt: this.now(),
                    updatedAt: this.now(),
                }
                : undefined,
        }));
        this.kick();
    }
    discardRevokedCandidate(terminalState) {
        const terminalCode = terminalState === "cancelled" ? "CLAIM_CANCELLED" : "CLAIM_EXPIRED";
        this.finishAttempt(terminalState, terminalCode);
    }
    finishAttempt(terminalState, terminalCode) {
        this.pairingSource.burn();
        this.stateStore.update((state) => {
            const attempt = state.attempt;
            if (!attempt)
                return { ...state, pendingCredential: undefined };
            return {
                ...state,
                pendingCredential: undefined,
                attempt: {
                    attemptId: attempt.attemptId,
                    mode: attempt.mode,
                    phase: "terminal",
                    serverOrigin: attempt.serverOrigin,
                    createdAt: attempt.createdAt,
                    updatedAt: this.now(),
                    ...(attempt.claimId ? { claimId: attempt.claimId } : {}),
                    terminalState,
                    ...(terminalCode ? { terminalCode } : {}),
                },
            };
        });
    }
    syncLegacyExpiry() {
        const state = this.stateStore.get();
        if (state.attempt?.mode === "legacy" && state.attempt.phase !== "terminal" && !this.pairingSource.isArmed()) {
            this.finishAttempt("expired", "CLAIM_EXPIRED");
            return this.stateStore.get();
        }
        return state;
    }
    recordFailure(error) {
        const code = error instanceof ClaimHttpError
            ? error.body?.code ?? `HTTP_${error.status}`
            : error instanceof ClaimTransportError
                ? "TRANSPORT"
                : error instanceof ClaimPersistenceError || this.isFilePersistenceFailure(error)
                    ? "PERSIST_FAILED"
                    : "PROTOCOL_ERROR";
        if (code === "CLAIM_DENIED")
            return this.finishAttempt("denied", code);
        if (code === "CLAIM_CANCELLED")
            return this.finishAttempt("cancelled", code);
        if (code === "CLAIM_EXPIRED")
            return this.finishAttempt("expired", code);
        if (code === "ATTEMPT_RETIRED")
            return this.finishAttempt("expired", code);
        if (code === "ROTATION_EXPIRED") {
            this.stateStore.update((state) => ({
                ...state,
                pendingCredential: undefined,
                rotation: undefined,
            }));
            return;
        }
        if (error instanceof ClaimHttpError && error.body
            && ["CREDENTIAL_REVOKED", "CREDENTIAL_INVALID", "CREDENTIAL_RETIRED"].includes(error.body.code)) {
            const rejectedBearer = this.stateStore.get().pendingCredential?.bearer
                ?? this.settingsSource.get().overseerToken;
            this.recordCredentialRejection(rejectedBearer, error.body.code);
            return;
        }
        const retryable = code === "TRANSPORT"
            || code === "PERSIST_FAILED"
            || code === "CLOCK_SKEW"
            || (error instanceof ClaimHttpError && (error.status === 429 || error.status >= 500));
        if (!retryable) {
            this.stateStore.update((state) => ({
                ...state,
                attempt: state.attempt && state.attempt.phase !== "terminal"
                    ? {
                        ...state.attempt,
                        phase: "parked",
                        lastErrorCode: code,
                        retryAt: undefined,
                        updatedAt: this.now(),
                    }
                    : state.attempt,
                rotation: state.rotation
                    ? {
                        ...state.rotation,
                        phase: "parked",
                        lastErrorCode: code,
                        retryAt: undefined,
                        updatedAt: this.now(),
                    }
                    : state.rotation,
            }));
            return;
        }
        const retryAfterMs = error instanceof ClaimHttpError ? error.body?.retryAfterMs : undefined;
        const retryAt = this.now() + (retryAfterMs ?? this.transientDelay());
        const correctedOffset = error instanceof ClaimHttpError && error.body?.code === "CLOCK_SKEW"
            ? error.body.serverTime - this.now()
            : undefined;
        this.stateStore.update((state) => ({
            ...state,
            attempt: state.attempt && state.attempt.phase !== "terminal"
                ? {
                    ...state.attempt,
                    lastErrorCode: code,
                    retryAt,
                    ...(correctedOffset === undefined ? {} : { serverClockOffsetMs: correctedOffset }),
                    updatedAt: this.now(),
                }
                : state.attempt,
            rotation: state.rotation
                ? {
                    ...state.rotation,
                    lastErrorCode: code,
                    retryAt,
                    ...(correctedOffset === undefined ? {} : { serverClockOffsetMs: correctedOffset }),
                    updatedAt: this.now(),
                }
                : state.rotation,
        }));
    }
    isFilePersistenceFailure(error) {
        const code = error?.code;
        return typeof code === "string" && [
            "EACCES",
            "EDQUOT",
            "EFBIG",
            "EIO",
            "EMFILE",
            "ENFILE",
            "ENOSPC",
            "EPERM",
            "EROFS",
        ].includes(code);
    }
    signedNow(offsetMs = 0) {
        return this.now() + offsetMs;
    }
    transientDelay() {
        return Math.min(TRANSIENT_RETRY_MAX_MS, TRANSIENT_RETRY_MIN_MS * (2 ** Math.min(this.transientFailures, 5)));
    }
    hasPendingWork() {
        const state = this.stateStore.get();
        return Boolean((state.rotation && state.rotation.phase !== "parked")
            || ((state.attempt?.mode === "claim" || state.attempt?.mode === "probe")
                && state.attempt.phase !== "terminal"
                && state.attempt.phase !== "parked"
                && !state.attempt.awaitingSocketConfirmation));
    }
    kick() {
        if (!this.started)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.onTimerScheduled?.(0);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.runOnce().catch(() => {
                // The stable error code is persisted and exposed through getStatus().
                // Request/response bodies, bearer material, and signatures are never logged.
            });
        }, 0);
    }
    scheduleNext() {
        if (!this.scheduling || this.timer || !this.started)
            return;
        const state = this.stateStore.get();
        const retryAt = state.rotation?.retryAt ?? state.attempt?.retryAt;
        const attemptDelay = state.attempt?.phase === "polling"
            ? (state.attempt.pollAfterMs ?? 2000) + Math.floor(this.random() * 501)
            : 0;
        const delay = Math.max(0, retryAt ? retryAt - this.now() : attemptDelay);
        this.onTimerScheduled?.(delay);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.runOnce().catch(() => { });
        }, delay);
    }
}
