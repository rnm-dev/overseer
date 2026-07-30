export interface PeonCredential {
  id: string;
  workspaceId: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
  boundPeonId: string | null;
  generation: number | null;
  method: "legacy" | "claim";
}

export interface Minted {
  credential: PeonCredential;
  token: string;
}
