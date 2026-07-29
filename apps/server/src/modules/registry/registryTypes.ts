export interface PeonRecord {
  peonId: string;
  credentialId: string;
  workspaceId: string;
  name: string;
  hostname: string | null;
  // The register request's source address (peon's tailnet IP) + reported
  // controlPort — where the overseer calls back. NAT'd peons need no public address.
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
