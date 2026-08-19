export type Role = "owner" | "member";

// How a person came to be in a workspace. Recorded because a member list that
// answers only "who" cannot answer "why are they here", which is the first
// question of any access review — and more so once a directory can add members
// without anyone clicking anything.
export type JoinedVia = "creator" | "invitation" | "sso";

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
}

export interface WorkspaceWithRole extends WorkspaceRecord {
  role: Role;
}

export interface MemberRecord {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  role: Role;
  addedAt: number;
}

export interface InviteRecord {
  id: string;
  workspaceId: string;
  token: string;
  inviteeLabel: string | null;
  role: Role;
  createdAt: number;
  expiresAt: number | null;
}

export type UpdateRoleResult = "updated" | "not_found" | "last_owner";

export type RemoveMemberResult = "removed" | "not_found" | "owner";

export type AcceptResult = { ok: true; workspace: WorkspaceWithRole; alreadyMember: boolean } | { ok: false };
