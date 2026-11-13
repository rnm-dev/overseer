import { randomUUID } from "node:crypto";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { registry, isPeonConnected, type PeonRecord } from "../fleet/index.js";
import { allowedProjects, canAccessPeon, canManageProject } from "../access/index.js";
import type { Role } from "../workspaces/index.js";
import { getIndexedProject } from "../projects/index.js";
import { flushSourceContext } from "../triggers/index.js";

// Overseer side of session sign-offs (docs/signoffs.md). Peon owns the record
// and the state machine; Overseer decides who may see and who may decide, and
// forwards decisions over Fleet HTTP. This first cut reads the online Peons
// live; consuming the durable `signoff-catalog-v1` projection (so that an
// offline Peon's sign-offs stay visible) is a follow-up.

export const SIGNOFF_CAPABILITY = "session-signoffs-v1";
const READ_TIMEOUT_MS = 10_000;

export const OPEN_STATUSES = ["pending", "changes_requested", "approved", "executing"] as const;
const DECIDABLE = new Set(["pending", "changes_requested"]);

export interface Viewer {
  workspaceId: string;
  userId: string;
  email: string;
  role: Role;
}

export interface PeonSignoffSummary {
  id: string;
  projectKey: string | null;
  number: number;
  displayNumber: string;
  title: string;
  sessionId: string;
  headSeq: number;
  status: string;
  assigneeIds: string[];
  orphaned: boolean;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface WorkspaceSignoff extends PeonSignoffSummary {
  peonId: string;
  peonName: string;
  /** The viewer may approve, reject or comment now. */
  canDecide: boolean;
  /** Waiting on the viewer: decidable, and they are named or nobody is. */
  awaitingViewer: boolean;
}

export interface UnavailablePeon {
  peonId: string;
  peonName: string;
  reason: "offline" | "unsupported" | "error";
}

function isSummary(value: unknown): value is PeonSignoffSummary {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.sessionId === "string"
    && typeof row.status === "string" && typeof row.headSeq === "number"
    && Array.isArray(row.assigneeIds);
}

function named(viewer: Viewer, assigneeIds: readonly string[]): boolean {
  const email = viewer.email.toLowerCase();
  return assigneeIds.some((id) => id === viewer.userId || id.toLowerCase() === email);
}

// Who may decide: the named assignees; otherwise the project's administrators
// and the workspace owners. A sign-off outside any project is the owners'.
export async function viewerMayDecide(viewer: Viewer, peonId: string, summary: PeonSignoffSummary): Promise<boolean> {
  if (summary.orphaned) return false;
  if (summary.assigneeIds.length > 0) return named(viewer, summary.assigneeIds) || viewer.role === "owner";
  if (viewer.role === "owner") return true;
  if (!summary.projectKey) return false;
  // Administrator grants are keyed by the project's id when it has one.
  const project = await getIndexedProject(peonId, summary.projectKey);
  return canManageProject(viewer.workspaceId, viewer.userId, viewer.role, peonId, summary.projectKey, project?.projectId ?? null);
}

async function visibleFilter(viewer: Viewer, peonId: string): Promise<(row: PeonSignoffSummary) => boolean> {
  const projects = await allowedProjects(viewer.workspaceId, viewer.userId, viewer.role, peonId);
  if (projects === null) return () => true;
  const keys = new Set(projects.map((project) => project.projectKey));
  // The same rule as a session (canAccessIndexedSessionNow): Peon access, and
  // project access when the sign-off belongs to a project. A named assignee
  // always sees what they are asked to decide.
  const peonAccess = await canAccessPeon(viewer.workspaceId, viewer.userId, viewer.role, peonId);
  return (row) => named(viewer, row.assigneeIds)
    || (peonAccess && (!row.projectKey || keys.has(row.projectKey)));
}

async function decorate(viewer: Viewer, record: PeonRecord, row: PeonSignoffSummary): Promise<WorkspaceSignoff> {
  const canDecide = DECIDABLE.has(row.status) && await viewerMayDecide(viewer, record.peonId, row);
  return {
    ...row,
    peonId: record.peonId,
    peonName: record.name,
    canDecide,
    awaitingViewer: canDecide && (row.assigneeIds.length === 0 || named(viewer, row.assigneeIds)),
  };
}

async function readPeon(viewer: Viewer, record: PeonRecord, status: readonly string[] | null, sessionId?: string): Promise<WorkspaceSignoff[] | UnavailablePeon> {
  const unavailable = (reason: UnavailablePeon["reason"]): UnavailablePeon => ({ peonId: record.peonId, peonName: record.name, reason });
  if (!isPeonConnected(record.peonId)) return unavailable("offline");
  const params = new URLSearchParams();
  if (status) params.set("status", status.join(","));
  if (sessionId) params.set("sessionId", sessionId);
  const query = params.size ? `?${params.toString()}` : "";
  const result = await callPeon(connOfRecord(record), "GET", `/signoffs${query}`, { actor: viewer.email, timeoutMs: READ_TIMEOUT_MS });
  if (result.status === 404) return unavailable("unsupported");
  if (!result.ok) return unavailable("error");
  const rows = (result.json as { signoffs?: unknown } | null)?.signoffs;
  if (!Array.isArray(rows)) return unavailable("error");
  const visible = await visibleFilter(viewer, record.peonId);
  return Promise.all(rows.filter(isSummary).filter(visible).map((row) => decorate(viewer, record, row)));
}

export async function listWorkspaceSignoffs(viewer: Viewer, scope: "open" | "all"): Promise<{
  signoffs: WorkspaceSignoff[];
  unavailable: UnavailablePeon[];
}> {
  const records = await registry.list(viewer.workspaceId);
  const accessible: PeonRecord[] = [];
  for (const record of records) {
    if (await canAccessPeon(viewer.workspaceId, viewer.userId, viewer.role, record.peonId)) accessible.push(record);
  }
  const results = await Promise.all(accessible.map((record) => readPeon(viewer, record, scope === "open" ? OPEN_STATUSES : null)));
  const signoffs: WorkspaceSignoff[] = [];
  const unavailable: UnavailablePeon[] = [];
  for (const result of results) {
    if (Array.isArray(result)) signoffs.push(...result);
    else unavailable.push(result);
  }
  signoffs.sort((a, b) => b.updatedAt - a.updatedAt);
  return { signoffs, unavailable };
}

export type SignoffReadResult =
  | { ok: true; view: Record<string, unknown> & { signoff: WorkspaceSignoff } }
  | { ok: false; status: number; body: { error: string; code: string } };

const notFound = { ok: false as const, status: 404, body: { error: "unknown sign-off", code: "UNKNOWN_SIGNOFF" } };
const offline = { ok: false as const, status: 503, body: { error: "the Peon is offline; its sign-offs cannot be read or decided now", code: "PEON_OFFLINE" } };

export async function getWorkspaceSignoff(viewer: Viewer, record: PeonRecord, signoffId: string): Promise<SignoffReadResult> {
  if (!isPeonConnected(record.peonId)) return offline;
  const result = await callPeon(connOfRecord(record), "GET", `/signoffs/${encodeURIComponent(signoffId)}`, { actor: viewer.email, timeoutMs: READ_TIMEOUT_MS });
  if (result.status === 404) return notFound;
  if (!result.ok) return { ok: false, status: result.status, body: result.json as { error: string; code: string } };
  const view = result.json as Record<string, unknown>;
  if (!isSummary(view?.signoff) || !(await visibleFilter(viewer, record.peonId))(view.signoff)) return notFound;
  return { ok: true, view: { ...view, signoff: await decorate(viewer, record, view.signoff) } };
}

export interface DecisionInput {
  kind: unknown;
  baseSeq: unknown;
  optionId?: unknown;
  message?: unknown;
  requestId?: unknown;
}

const OPERATOR_KINDS = new Set(["commented", "approved", "rejected", "withdrawn"]);

export async function decideWorkspaceSignoff(
  viewer: Viewer,
  record: PeonRecord,
  signoffId: string,
  input: DecisionInput,
): Promise<{ status: number; body: unknown }> {
  if (typeof input.kind !== "string" || !OPERATOR_KINDS.has(input.kind)) {
    return { status: 400, body: { error: "kind must be commented, approved, rejected or withdrawn", code: "BAD_REQUEST" } };
  }
  const read = await getWorkspaceSignoff(viewer, record, signoffId);
  if (!read.ok) return read;
  const summary = read.view.signoff;
  // Anyone who sees the sign-off may comment; deciding needs the decider's right.
  const mayAct = input.kind === "commented" ? !summary.orphaned : await viewerMayDecide(viewer, record.peonId, summary);
  if (!mayAct) return { status: 403, body: { error: "you cannot decide this sign-off", code: "SIGNOFF_FORBIDDEN" } };
  // Pre-execution check: anything the session's trigger source received since
  // reaches the agent before the decision does (docs/triggers.md).
  if (input.kind === "approved" || input.kind === "commented") {
    // A failed flush blocks the decision: deciding blind is what this check prevents.
    try {
      await flushSourceContext(record, viewer.email, summary.sessionId);
    } catch (error) {
      return { status: 502, body: { error: error instanceof Error ? error.message : "could not deliver new messages", code: "SOURCE_FLUSH_FAILED" } };
    }
  }
  const requestId = typeof input.requestId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(input.requestId)
    ? input.requestId
    : randomUUID();
  const result = await callPeon(connOfRecord(record), "POST", `/signoffs/${encodeURIComponent(signoffId)}/events`, {
    actor: viewer.email,
    body: {
      requestId,
      kind: input.kind,
      baseSeq: input.baseSeq,
      optionId: input.optionId,
      message: input.message,
      operatorId: viewer.email,
    },
  });
  return { status: result.status, body: result.json };
}

// One session's open sign-offs, for the banner above its composer.
// Each carries its summary: the card in the transcript shows it, and a session
// has only a handful open at a time.
export async function listSessionSignoffs(viewer: Viewer, record: PeonRecord, sessionId: string): Promise<Array<WorkspaceSignoff & { summary: string | null }>> {
  const result = await readPeon(viewer, record, OPEN_STATUSES, sessionId);
  if (!Array.isArray(result)) return [];
  return Promise.all(result.map(async (row) => {
    const view = await getWorkspaceSignoff(viewer, record, row.id);
    const snapshot = view.ok ? (view.view as { snapshot?: { summary?: unknown } }).snapshot : undefined;
    return { ...row, summary: typeof snapshot?.summary === "string" ? snapshot.summary : null };
  }));
}
