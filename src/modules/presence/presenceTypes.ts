export interface PresenceIdentity {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface StoredPresence extends PresenceIdentity {
  connectionId: string;
  workspaceId: string;
  scope: "workspace" | "peon" | "session";
  peonId: string | null;
  sessionId: string | null;
  projectKey: string | null;
  projectId: string | null;
  expiresAt: number;
}

export type VisiblePresence = Omit<StoredPresence, "connectionId" | "workspaceId" | "projectKey" | "projectId" | "expiresAt">;

