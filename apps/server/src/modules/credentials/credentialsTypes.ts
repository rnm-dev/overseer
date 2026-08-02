export interface PeonCredential {
  id: string;
  workspaceId: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
  boundPeonId: string | null;
}

export interface Minted {
  credential: PeonCredential;
  token: string;
}
