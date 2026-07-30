export interface PeonRecord {
  peonId: string;
  credentialId: string;
  workspaceId: string;
  name: string;
  hostname: string | null;
  // Optional legacy callback metadata. Claim-mode reverse Peons use an empty
  // address and port 0; it must never be treated as their connection identity.
  address: string;
  controlPort: number;
  publicUrl: string | null;
  addressSource: AddressSource;
  protocol: number | null;
  capabilities: string[];
  // The credential's token, presented back when the overseer calls this peon.
  token: string;
  // Operator pinned address/controlPort — register() won't overwrite them.
  connectionPinned: boolean;
  registeredAt: number;
  lastSeen: number;
  load: PeonLoad | null;
}

export type AddressSource = "paired" | "manual" | "advertised" | "discovered";

export interface PeonLoad {
  activeSessions: number;
  paused: boolean;
  uptimeSec: number;
}

// The operator-facing shape: never leak the raw credential token.
export type PeonView = Omit<PeonRecord, "token"> & {
  online: boolean;
  controlConnected: boolean;
  transferConnected: boolean;
  controlConnectedAt: number | null;
  transferConnectedAt: number | null;
  baseUrl: string;
};

export interface RegisterInput {
  peonId: string;
  credentialId: string;
  workspaceId: string;
  name: string;
  hostname: string | null;
  address: string;
  controlPort: number;
  publicUrl?: string | null;
  protocol: number | null;
  capabilities: string[];
  token: string;
  load: PeonLoad | null;
}
