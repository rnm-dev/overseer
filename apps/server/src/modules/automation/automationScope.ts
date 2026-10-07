import { registry, type PeonRecord } from "../fleet/index.js";
import { membership, type Role } from "../workspaces/index.js";
import { getUserById } from "../auth/index.js";
import { allowedProjects, canAccessPeon, canAccessProject } from "../access/index.js";
import { verifyAutomationToken } from "./automationTokens.js";
import type { AutomationTokenRecord } from "./automationTokenTypes.js";

// What a verified automation request may do, once the token's frozen scope has
// been intersected with the owner's live ACL.
export interface AutomationContext {
  token: AutomationTokenRecord;
  record: PeonRecord;
  workspaceId: string;
  userId: string;
  role: Role;
  // The operator identity every Peon call is attributed to. A machine caller
  // is not a separate principal: the run is authored by whoever minted the
  // token, so it is billed and displayed exactly like a hand-started one.
  operator: { email: string; githubLogin: string | null };
  // `null` on a Peon-scoped token — the caller may use any project its owner
  // can still reach.
  projectKey: string | null;
  projectId: string | null;
}

export type AutomationRefusal =
  | { code: "UNAUTHENTICATED"; status: 401; message: string }
  | { code: "UNKNOWN_PEON"; status: 404; message: string };

// Every refusal below is the same one an unauthorized operator would get.
// A token whose owner lost access must not be distinguishable from a token
// aimed at a Peon that never existed.
const unknownPeon: AutomationRefusal = { code: "UNKNOWN_PEON", status: 404, message: "unknown peon" };

export async function resolveAutomationRequest(rawToken: string): Promise<AutomationContext | AutomationRefusal> {
  const token = await verifyAutomationToken(rawToken);
  if (!token) return { code: "UNAUTHENTICATED", status: 401, message: "invalid, expired or revoked automation token" };

  const record = await registry.get(token.peonId);
  if (!record || record.workspaceId !== token.workspaceId) return unknownPeon;

  const user = await getUserById(token.userId);
  if (!user) return unknownPeon;

  const role = await membership(token.workspaceId, token.userId);
  if (!role) return unknownPeon;
  if (!(await canAccessPeon(token.workspaceId, token.userId, role, record.peonId))) return unknownPeon;

  if (token.projectKey || token.projectId) {
    const reachable = await canAccessProject(
      token.workspaceId,
      token.userId,
      role,
      record.peonId,
      token.projectKey ?? "",
      token.projectId,
    );
    if (!reachable) return unknownPeon;
  }

  return {
    token,
    record,
    workspaceId: token.workspaceId,
    userId: token.userId,
    role,
    operator: { email: user.email, githubLogin: user.githubLogin },
    projectKey: token.projectKey,
    projectId: token.projectId,
  };
}

// May this request touch a session that belongs to `projectKey`? A
// project-scoped token is confined to its own project; a Peon-scoped one
// follows its owner's project grants, exactly as the operator routes do.
export async function automationMayUseProject(
  context: AutomationContext,
  projectKey: string | null,
  projectId: string | null,
): Promise<boolean> {
  if (context.projectId || context.projectKey) {
    if (context.projectId && projectId) return context.projectId === projectId;
    return context.projectKey === projectKey;
  }
  // A session with no project is Peon-wide work; Peon access already covers it.
  if (!projectKey) return true;
  return canAccessProject(context.workspaceId, context.userId, context.role, context.record.peonId, projectKey, projectId);
}

// The project filter a listing must apply. `null` means "no extra filter" —
// either the owner is a workspace owner or the token is Peon-scoped and the
// per-row access join already does the narrowing.
export async function automationProjectFilter(context: AutomationContext): Promise<
  { projectId: string | null; projectKey: string | null } | null
> {
  if (context.projectId || context.projectKey) {
    return { projectId: context.projectId, projectKey: context.projectKey };
  }
  return null;
}

// The projects a Peon-scoped token may name when starting a session. `null`
// means unrestricted (workspace owner).
export async function automationAllowedProjects(context: AutomationContext) {
  return allowedProjects(context.workspaceId, context.userId, context.role, context.record.peonId);
}
