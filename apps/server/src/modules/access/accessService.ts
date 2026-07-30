import { query, transaction } from "../../db.js";
import type { Role } from "../../workspaces.js";
import type { AccessQuery, MemberAccess } from "./accessTypes.js";

export function projectAccessQuery(
  workspaceId: string,
  userId: string,
  peonId: string,
  projectKey: string,
  projectId?: string | null,
): AccessQuery {
  if (projectId) {
    return {
      text: `SELECT 1 FROM workspace_member_project_access
        WHERE workspace_id = $1 AND user_id = $2 AND peon_id = $3 AND project_id = $4`,
      values: [workspaceId, userId, peonId, projectId],
    };
  }
  return {
    text: `SELECT 1 FROM workspace_member_project_access
      WHERE workspace_id = $1 AND user_id = $2 AND peon_id = $3
        AND project_id IS NULL AND project_key = $4`,
    values: [workspaceId, userId, peonId, projectKey],
  };
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

export async function canAccessProject(
  workspaceId: string,
  userId: string,
  role: Role,
  peonId: string,
  projectKey: string,
  projectId?: string | null,
): Promise<boolean> {
  if (role === "owner") return true;
  const lookup = projectAccessQuery(workspaceId, userId, peonId, projectKey, projectId);
  const { rows } = await query(lookup.text, lookup.values);
  return rows.length > 0;
}

// Authoritative projected-session gate for transcript replay/live delivery.
// Unlike a browser socket's cached access snapshot, this reads membership,
// Peon grant, current indexed session scope and project grant together. Call it
// immediately before delivering projected transcript data.
export async function canAccessIndexedSessionNow(
  workspaceId: string,
  userId: string,
  peonId: string,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await query<{
    role: Role;
    project_key: string | null;
    project_id: string | null;
    peon_allowed: boolean;
    project_allowed: boolean;
  }>(
    `SELECT member.role,
            session.project_key,
            session.project_id,
            (peon_access.peon_id IS NOT NULL) AS peon_allowed,
            (project_access.peon_id IS NOT NULL) AS project_allowed
       FROM workspace_members member
       JOIN sessions session
         ON session.peon_id=$3 AND session.session_id=$4
       LEFT JOIN workspace_member_peon_access peon_access
         ON peon_access.workspace_id=$1
        AND peon_access.user_id=$2
        AND peon_access.peon_id=$3
       LEFT JOIN workspace_member_project_access project_access
         ON project_access.workspace_id=$1
        AND project_access.user_id=$2
        AND project_access.peon_id=$3
        AND (
          (session.project_id IS NOT NULL AND project_access.project_id=session.project_id)
          OR (
            session.project_id IS NULL
            AND project_access.project_id IS NULL
            AND project_access.project_key=session.project_key
          )
        )
      WHERE member.workspace_id=$1 AND member.user_id=$2`,
    [workspaceId, userId, peonId, sessionId],
  );
  return rows.some((row) =>
    row.role === "owner"
    || (row.peon_allowed && ((!row.project_key && !row.project_id) || row.project_allowed)));
}

export async function allowedProjects(
  workspaceId: string,
  userId: string,
  role: Role,
  peonId: string,
): Promise<MemberAccess["projects"] | null> {
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

export async function projectMemberCounts(
  workspaceId: string,
  peonId: string,
  projects: Array<{ projectId?: string | null; key: string }>,
): Promise<number[]> {
  const [owners, grants] = await Promise.all([
    query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM workspace_members
       WHERE workspace_id = $1 AND role = 'owner'`,
      [workspaceId],
    ),
    query<{ user_id: string; project_id: string | null; project_key: string }>(
      `SELECT DISTINCT a.user_id,a.project_id,a.project_key
       FROM workspace_member_project_access a
       JOIN workspace_members m
         ON m.workspace_id=a.workspace_id AND m.user_id=a.user_id AND m.role='member'
       WHERE a.workspace_id=$1 AND a.peon_id=$2`,
      [workspaceId, peonId],
    ),
  ]);
  const ownerCount = Number(owners.rows[0]?.count ?? 0);
  return projects.map((project) => {
    const members = new Set(grants.rows
      .filter((grant) => project.projectId
        ? grant.project_id === project.projectId || (grant.project_id === null && grant.project_key === project.key)
        : grant.project_id === null && grant.project_key === project.key)
      .map((grant) => grant.user_id));
    return ownerCount + members.size;
  });
}
