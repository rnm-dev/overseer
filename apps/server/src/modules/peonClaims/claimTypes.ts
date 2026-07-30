import type { PublicJwk } from "./claimCrypto.js";

export interface ClaimDisplay {
  name: string;
  platform: "darwin" | "linux" | "windows";
  architecture: "arm64" | "x64";
  daemonVersion: string;
}

export interface ClaimRow {
  claim_id: string;
  attempt_id: string;
  request_hash: string;
  peon_id: string;
  identity_key_id: string;
  public_jwk: PublicJwk;
  claim_nonce: string;
  server_origin: string;
  claim_token_hash: string | null;
  operator_code_hash: string | null;
  operator_code_key_version: number | null;
  operator_code_nonce: string | null;
  operator_code_ciphertext: string | null;
  operator_code_tag: string | null;
  display: ClaimDisplay;
  state: "pending" | "approved" | "completed" | "denied" | "cancelled" | "expired";
  mode: "new" | "recover" | null;
  workspace_id: string | null;
  decided_by: string | null;
  decision: "approve" | "deny" | null;
  credential_id: string | null;
  delivery_id: string | null;
  created_at: number;
  expires_at: number;
  delivery_expires_at: number | null;
  delivered_at: number | null;
  terminal_at: number | null;
  terminal_polled_at: number | null;
  completed_at: number | null;
  ack_request_hash: string | null;
  ack_result_expires_at: number | null;
}

export interface ClaimCredentialRow {
  id: string;
  workspace_id: string;
  peon_id: string;
  identity_key_id: string;
  generation: number;
  state: "pending" | "active" | "retiring" | "revoked";
  verifier: string;
  pepper_version: number;
  created_at: number;
  activated_at: number | null;
  retiring_at: number | null;
  old_socket_grace_ends_at: number | null;
  revoked_at: number | null;
}

export interface DeliveryRow {
  delivery_id: string;
  owner_type: "claim" | "rotation";
  owner_id: string;
  credential_id: string;
  peon_id: string;
  workspace_id: string;
  identity_key_id: string;
  generation: number;
  key_version: number;
  nonce: string;
  ciphertext: string;
  tag: string;
  created_at: number;
  expires_at: number;
}

export class ClaimServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
