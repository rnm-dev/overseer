import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../xdgPaths.js";
import {
  secureExistingPrivateFile,
  writePrivateFileDurably,
} from "../durablePrivateFile.js";

export type EnrollmentMode = "probe" | "claim" | "legacy";
export type EnrollmentPhase =
  | "probing"
  | "starting"
  | "polling"
  | "approved"
  | "acknowledging"
  | "reconciling"
  | "parked"
  | "terminal";

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface StoredClaimAttempt {
  attemptId: string;
  mode: EnrollmentMode;
  phase: EnrollmentPhase;
  serverOrigin: string;
  createdAt: number;
  updatedAt: number;
  claimNonce?: string;
  claimToken?: string;
  requestHash?: string;
  startSemantic?: Record<string, unknown>;
  ackRequestHash?: string;
  claimId?: string;
  operatorCode?: string;
  operatorUrl?: string;
  expiresAt?: number;
  pollAfterMs?: number;
  terminalState?: "completed" | "denied" | "cancelled" | "expired";
  terminalCode?: string;
  lastErrorCode?: string;
  retryAt?: number;
  serverClockOffsetMs?: number;
  cancelRequested?: boolean;
  awaitingSocketConfirmation?: boolean;
}

export interface StoredCredential {
  serverOrigin: string;
  peonId: string;
  identityKeyId: string;
  workspaceId: string;
  credentialId: string;
  generation: number;
  state: "active" | "revoked";
  serverClockOffsetMs?: number;
}

export interface StoredPendingCredential extends Omit<StoredCredential, "state"> {
  state: "pending";
  bearer: string;
  deliveryId: string;
  expiresAt: number;
}

export interface StoredRotation {
  rotationId: string;
  phase: "starting" | "polling" | "acknowledging" | "parked";
  createdAt: number;
  updatedAt: number;
  requestHash: string;
  startSemantic: Record<string, unknown>;
  ackRequestHash?: string;
  pendingCredential?: StoredPendingCredential;
  lastErrorCode?: string;
  retryAt?: number;
  serverClockOffsetMs?: number;
}

export interface EnrollmentState {
  version: 1;
  identity?: {
    peonId: string;
    identityKeyId: string;
    publicKey: PublicJwk;
  };
  attempt?: StoredClaimAttempt;
  credential?: StoredCredential;
  pendingCredential?: StoredPendingCredential;
  rotation?: StoredRotation;
}

export const EMPTY_ENROLLMENT_STATE: EnrollmentState = { version: 1 };

export interface EnrollmentStatePersistence {
  get(): EnrollmentState;
  replace(next: EnrollmentState): EnrollmentState;
  update(mutator: (current: EnrollmentState) => EnrollmentState): EnrollmentState;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class EnrollmentStateStore implements EnrollmentStatePersistence {
  private current: EnrollmentState;

  constructor(private readonly filePath = path.join(stateDir(), "enrollment-v1.json")) {
    this.current = this.read();
  }

  get(): EnrollmentState {
    return clone(this.current);
  }

  replace(next: EnrollmentState): EnrollmentState {
    if (next.version !== 1) throw new Error("unsupported enrollment state version");
    writePrivateFileDurably(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    this.current = clone(next);
    return this.get();
  }

  update(mutator: (current: EnrollmentState) => EnrollmentState): EnrollmentState {
    return this.replace(mutator(this.get()));
  }

  private read(): EnrollmentState {
    if (!existsSync(this.filePath)) return clone(EMPTY_ENROLLMENT_STATE);
    secureExistingPrivateFile(this.filePath);
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as EnrollmentState;
    if (!parsed || parsed.version !== 1) throw new Error("invalid enrollment state");
    return parsed;
  }
}
