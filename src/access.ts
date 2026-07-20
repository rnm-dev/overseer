import { query, transaction } from "./db.js";
import type { Role } from "./workspaces.js";

export interface MemberAccess {
  peonIds: string[];
  projects: { peonId: string; projectKey: string; projectId?: string | null }[];
}

export async function listMemberAccess(workspaceId: string, userId: string): Promise<MemberAccess> {
  const [peons, projects] = await Promise.all([
    query<{ peon_id: string }>(
      `SELECT peon_id FROM workspace_member_peon_access WHERE workspace_id = $1 AND user_id = $2 ORDER BY peon_id`,
      [workspaceId, userId],
    ),
    query<{ peon_id: string; project_key: string; project_id: string | null }>(
      `SELECT peon_id, project_key, project_id FROM workspace_member_project_access WHERE workspace_id = $1 AND user_id = $2 ORDER BY peon_id, project_key`,
      [workspaceId, userId],
    ),
  ]);
  return {
    peonIds: peons.rows.map((row) => row.peon_id),
    projects: projects.rows.map((row) => ({ peonId: row.peon_id, projectKey: row.project_key, projectId: row.project_id })),
  };
}

export async function replaceMemberAccess(workspaceId: string, userId: string, value: MemberAccess, grantedBy: string): Promise<void> {
  await transaction(async (tx) => {
    await tx.query(`DELETE FROM workspace_member_project_access WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    await tx.query(`DELETE FROM workspace_member_peon_access WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    const now = Date.now();
    for (const peonId of [...new Set(value.peonIds)]) {
      await tx.query(
        `INSERT INTO workspace_member_peon_access (workspace_id, user_id, peon_id, granted_at, granted_by) VALUES ($1,$2,$3,$4,$5)`,
        [workspaceId, userId, peonId, now, grantedBy],
      );
    }
    const uniqueProjects = new Map(value.projects.map((item) => [`${item.peonId}\0${item.projectId || `key:${item.projectKey}`}`, item]));
    for (const { peonId, projectKey, projectId } of uniqueProjects.values()) {
      await tx.query(
        `INSERT INTO workspace_member_project_access (workspace_id, user_id, peon_id, project_key, project_id, granted_at, granted_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [workspaceId, userId, peonId, projectKey, projectId ?? null, now, grantedBy],
      );
    }
  });
}

export async function canAccessPeon(workspaceId: string, userId: string, role: Role, peonId: string): Promise<boolean> {
  if (role === "owner") return true;
  const { rows } = await query(
    `SELECT 1 FROM workspace_member_peon_access WHERE workspace_id = $1 AND user_id = $2 AND peon_id = $3`,
    [workspaceId, userId, peonId],
  );
  return rows.length > 0;
}

export async function canAccessProject(workspaceId: string, userId: string, role: Role, peonId: string, projectKey: string, projectId?: string | null): Promise<boolean> {
  if (role === "owner") return true;
  const { rows } = await query(
    `SELECT 1 FROM workspace_member_project_access
      WHERE workspace_id = $1 AND user_id = $2 AND peon_id = $3
        AND (${projectId ? `project_id = $5` : `project_id IS NULL AND project_key = $4`})`,
    projectId ? [workspaceId, userId, peonId, projectKey, projectId] : [workspaceId, userId, peonId, projectKey],
  );
  return rows.length > 0;
}

export async function allowedProjects(workspaceId: string, userId: string, role: Role, peonId: string): Promise<MemberAccess["projects"] | null> {
  if (role === "owner") return null;
  const { rows } = await query<{ project_key: string; project_id: string | null }>(
    `SELECT project_key, project_id FROM workspace_member_project_access WHERE workspace_id = $1 AND user_id = $2 AND peon_id = $3`,
    [workspaceId, userId, peonId],
  );
  return rows.map((row) => ({ peonId, projectKey: row.project_key, projectId: row.project_id }));
}

export async function allowedProjectKeys(workspaceId: string, userId: string, role: Role, peonId: string): Promise<string[] | null> {
  const projects = await allowedProjects(workspaceId, userId, role, peonId);
  return projects?.map((row) => row.projectKey) ?? null;
}
