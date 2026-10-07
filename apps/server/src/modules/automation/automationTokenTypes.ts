// An automation token is minted by an operator and handed to a machine. It
// names one Peon, optionally one project, and nothing else. The secret half is
// never stored and never shown twice.

export interface AutomationTokenScope {
  workspaceId: string;
  peonId: string;
  projectId: string | null;
  projectKey: string | null;
}

export interface AutomationTokenRecord extends AutomationTokenScope {
  id: string;
  userId: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

// What an operator sees in project settings. The secret is absent by
// construction — `issueAutomationToken` returns it once, beside this view.
export interface AutomationTokenView {
  id: string;
  label: string | null;
  peonId: string;
  projectKey: string | null;
  projectId: string | null;
  ownerUserId: string;
  ownerEmail: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  mine: boolean;
}

export const AUTOMATION_TOKEN_PREFIX = "ovsr_at_";
