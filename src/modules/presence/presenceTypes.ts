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
  // Route presence keeps a backgrounded tab in the viewer list, but "the operator
  // is actually looking at this" needs focus/visibility too. Absent ⇒ active.
  active?: boolean;
  expiresAt: number;
}

export type VisiblePresence = Omit<StoredPresence, "connectionId" | "workspaceId" | "projectKey" | "projectId" | "expiresAt" | "active">;

