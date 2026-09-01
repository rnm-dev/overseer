export interface MemberAccess {
  peonIds: string[];
  projects: { peonId: string; projectKey: string; projectId?: string | null }[];
}

export interface AccessQuery {
  text: string;
  values: string[];
}

export interface ProjectMemberAccess {
  userId: string;
  access: boolean;
  administrator: boolean;
}
