// Session sign-offs: the pure model. A sign-off is a head plus an append-only
// event log; everything the head says (status, current snapshot, assignees) is
// derived from the events, so the head can always be rebuilt. No I/O here —
// storage and delivery live in store.ts and service.ts. See docs/signoffs.md.

export const SIGNOFFS_CAPABILITY = "session-signoffs-v1";

export const LIMITS = {
  options: 6,
  actionsPerOption: 10,
  assignees: 10,
  contextExcerpts: 5,
  id: 64,
  title: 200,
  summary: 4_000,
  label: 200,
  rationale: 2_000,
  actionSummary: 500,
  actionDetail: 8_000,
  contextExcerpt: 1_000,
  assignee: 200,
  message: 8_000,
  resultNote: 2_000,
  snapshotBytes: 64 * 1024,
} as const;

export type SignoffActionType = "freeform";

export interface SignoffAction {
  id: string;
  summary: string;
  detail?: string;
  type: SignoffActionType;
}

export interface SignoffOption {
  id: string;
  label: string;
  recommended?: boolean;
  rationale?: string;
  actions: SignoffAction[];
}

export interface SignoffSnapshot {
  title: string;
  summary: string;
  options: SignoffOption[];
  assignees: string[];
  /** Short excerpts from the triggering event, never whole payloads. */
  context: string[];
}

export type SignoffAuthor =
  | { type: "agent"; sessionId: string }
  | { type: "operator"; id: string }
  | { type: "policy" }
  /** Peon itself, only for closing an interrupted execution. */
  | { type: "peon" };

export type SignoffEventKind =
  | "proposed"
  | "revised"
  | "answered"
  | "commented"
  | "approved"
  | "rejected"
  | "reassigned"
  | "withdrawn"
  | "superseded"
  | "executing"
  | "executed"
  | "interrupted";

export type ActionResultOutcome = "done" | "failed" | "skipped" | "unknown";

export interface ActionResult {
  actionId: string;
  outcome: ActionResultOutcome;
  note?: string;
}

export interface SignoffEvent {
  seq: number;
  author: SignoffAuthor;
  kind: SignoffEventKind;
  /** The head seq the author was looking at. */
  baseSeq: number | null;
  snapshot?: SignoffSnapshot;
  message?: string;
  optionId?: string;
  assigneeIds?: string[];
  supersededBy?: string;
  results?: ActionResult[];
  /** Operator request id; a retry with the same id is answered from this event. */
  requestId?: string;
  createdAt: number;
}

export type SignoffStatus =
  | "pending"
  | "changes_requested"
  | "approved"
  | "executing"
  | "done"
  | "partly_done"
  | "failed"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "interrupted";

export const TERMINAL_STATUSES: ReadonlySet<SignoffStatus> = new Set([
  "done", "partly_done", "failed", "rejected", "withdrawn", "superseded", "interrupted",
]);

export interface SignoffSource {
  id: string | null;
  source: string | null;
  correlationId: string | null;
}

export interface SignoffHead {
  id: string;
  projectKey: string | null;
  number: number;
  sessionId: string;
  source: SignoffSource | null;
  headSeq: number;
  status: SignoffStatus;
  assigneeIds: string[];
  /** The session was deleted; the sign-off stays visible but cannot be decided. */
  orphaned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SignoffRecord {
  head: SignoffHead;
  events: SignoffEvent[];
}

export class SignoffError extends Error {
  constructor(
    readonly code:
      | "BAD_REQUEST"
      | "UNKNOWN_SIGNOFF"
      | "SIGNOFF_CHANGED"
      | "SIGNOFF_STATE"
      | "SIGNOFF_SESSION_GONE"
      | "SIGNOFF_NOT_ALLOWED"
      | "IDEMPOTENCY_CONFLICT",
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    switch (this.code) {
      case "BAD_REQUEST": return 400;
      case "UNKNOWN_SIGNOFF": return 404;
      case "SIGNOFF_SESSION_GONE": return 410;
      case "SIGNOFF_NOT_ALLOWED": return 403;
      default: return 409;
    }
  }
}

// --- validation ------------------------------------------------------------

function bad(message: string): never {
  throw new SignoffError("BAD_REQUEST", message);
}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") bad(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) bad(`${field} is required`);
    return undefined;
  }
  if (trimmed.length > max) bad(`${field} exceeds ${max} characters`);
  return trimmed;
}

function identifier(value: unknown, field: string): string {
  const id = text(value, field, LIMITS.id)!;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) bad(`${field} may contain only letters, digits, '.', '_' and '-'`);
  return id;
}

function list(value: unknown, field: string, max: number, min = 0): unknown[] {
  if (value === undefined || value === null) {
    if (min > 0) bad(`${field} is required`);
    return [];
  }
  if (!Array.isArray(value)) bad(`${field} must be an array`);
  if (value.length < min) bad(`${field} needs at least ${min} item${min === 1 ? "" : "s"}`);
  if (value.length > max) bad(`${field} allows at most ${max} items`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(`${field} must be an object`);
  return value as Record<string, unknown>;
}

export function parseAssignees(value: unknown, field = "assignees"): string[] {
  const out = list(value, field, LIMITS.assignees).map((item, i) => text(item, `${field}[${i}]`, LIMITS.assignee)!);
  return [...new Set(out)];
}

export function parseSnapshot(value: unknown): SignoffSnapshot {
  const raw = object(value, "snapshot");
  const optionIds = new Set<string>();
  const options = list(raw.options, "options", LIMITS.options, 1).map((rawOption, i) => {
    const option = object(rawOption, `options[${i}]`);
    const id = identifier(option.id, `options[${i}].id`);
    if (optionIds.has(id)) bad(`options[${i}].id '${id}' is not unique`);
    optionIds.add(id);
    const actionIds = new Set<string>();
    // An option is a plan the agent would carry out; "do nothing" is what
    // rejecting is for, so every option names at least one action.
    const actions = list(option.actions, `options[${i}].actions`, LIMITS.actionsPerOption, 1).map((rawAction, j) => {
      const action = object(rawAction, `options[${i}].actions[${j}]`);
      const actionId = identifier(action.id, `options[${i}].actions[${j}].id`);
      if (actionIds.has(actionId)) bad(`options[${i}].actions[${j}].id '${actionId}' is not unique`);
      actionIds.add(actionId);
      if (action.type !== undefined && action.type !== "freeform") bad(`options[${i}].actions[${j}].type must be "freeform"`);
      const detail = text(action.detail, `options[${i}].actions[${j}].detail`, LIMITS.actionDetail, false);
      return {
        id: actionId,
        summary: text(action.summary, `options[${i}].actions[${j}].summary`, LIMITS.actionSummary)!,
        ...(detail ? { detail } : {}),
        type: "freeform" as const,
      };
    });
    const rationale = text(option.rationale, `options[${i}].rationale`, LIMITS.rationale, false);
    if (option.recommended !== undefined && typeof option.recommended !== "boolean") bad(`options[${i}].recommended must be a boolean`);
    return {
      id,
      label: text(option.label, `options[${i}].label`, LIMITS.label)!,
      ...(option.recommended === true ? { recommended: true } : {}),
      ...(rationale ? { rationale } : {}),
      actions,
    };
  });
  const rawContext = typeof raw.context === "string" ? [raw.context] : raw.context;
  const context = list(rawContext, "context", LIMITS.contextExcerpts)
    .map((item, i) => text(item, `context[${i}]`, LIMITS.contextExcerpt)!);
  const snapshot: SignoffSnapshot = {
    title: text(raw.title, "title", LIMITS.title)!,
    summary: text(raw.summary, "summary", LIMITS.summary)!,
    options,
    assignees: parseAssignees(raw.assignees),
    context,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > LIMITS.snapshotBytes) {
    bad(`snapshot exceeds ${LIMITS.snapshotBytes} bytes`);
  }
  return snapshot;
}

export function parseMessage(value: unknown, required: boolean): string | undefined {
  return text(value, "message", LIMITS.message, required);
}

export function parseResults(value: unknown, option: SignoffOption): ActionResult[] {
  const known = new Set(option.actions.map((action) => action.id));
  const seen = new Set<string>();
  const results = list(value, "results", LIMITS.actionsPerOption, 1).map((rawResult, i) => {
    const result = object(rawResult, `results[${i}]`);
    const actionId = identifier(result.actionId, `results[${i}].actionId`);
    if (!known.has(actionId)) bad(`results[${i}].actionId '${actionId}' is not an action of the approved option`);
    if (seen.has(actionId)) bad(`results[${i}].actionId '${actionId}' is reported twice`);
    seen.add(actionId);
    if (!["done", "failed", "skipped"].includes(result.outcome as string)) {
      bad(`results[${i}].outcome must be done, failed or skipped`);
    }
    const note = text(result.note, `results[${i}].note`, LIMITS.resultNote, false);
    return { actionId, outcome: result.outcome as ActionResultOutcome, ...(note ? { note } : {}) };
  });
  const missing = [...known].filter((id) => !seen.has(id));
  if (missing.length) bad(`results must report every action of the approved option; missing: ${missing.join(", ")}`);
  return results;
}

// --- derivation ------------------------------------------------------------

export function executedStatus(results: ActionResult[]): SignoffStatus {
  const done = results.filter((result) => result.outcome === "done").length;
  if (done === results.length) return "done";
  return done === 0 ? "failed" : "partly_done";
}

/** Status after `event`, given the status before it. */
export function statusAfter(previous: SignoffStatus | null, event: SignoffEvent): SignoffStatus {
  switch (event.kind) {
    case "proposed":
    case "revised":
    case "answered":
      return "pending";
    case "commented":
      return "changes_requested";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "reassigned":
      return previous ?? "pending";
    case "withdrawn":
      return "withdrawn";
    case "superseded":
      return "superseded";
    case "executing":
      return "executing";
    case "executed":
      return executedStatus(event.results ?? []);
    case "interrupted":
      return "interrupted";
  }
}

export interface DerivedSignoff {
  status: SignoffStatus;
  snapshot: SignoffSnapshot;
  /** Seq of the latest event carrying a snapshot: what a decision approves. */
  snapshotSeq: number;
  assigneeIds: string[];
  /** The approval in force while approved / executing / executed. */
  approval: SignoffEvent | null;
}

export function derive(events: readonly SignoffEvent[]): DerivedSignoff {
  if (!events.length || events[0]!.kind !== "proposed" || !events[0]!.snapshot) {
    throw new Error("a sign-off history must start with a proposed event carrying a snapshot");
  }
  let status: SignoffStatus | null = null;
  let snapshot = events[0]!.snapshot;
  let snapshotSeq = events[0]!.seq;
  let assigneeIds = snapshot.assignees;
  let approval: SignoffEvent | null = null;
  events.forEach((event, index) => {
    if (event.seq !== index + 1) throw new Error(`sign-off history is not contiguous at seq ${event.seq}`);
    if (event.snapshot) {
      snapshot = event.snapshot;
      snapshotSeq = event.seq;
      assigneeIds = event.snapshot.assignees;
    }
    if (event.assigneeIds) assigneeIds = event.assigneeIds;
    if (event.kind === "approved") approval = event;
    if (event.kind === "revised") approval = null;
    status = statusAfter(status, event);
  });
  return { status: status!, snapshot, snapshotSeq, assigneeIds, approval };
}

export function approvedOption(derived: DerivedSignoff, events: readonly SignoffEvent[]): SignoffOption {
  const approval = derived.approval;
  if (!approval?.optionId || approval.baseSeq === null) throw new SignoffError("SIGNOFF_STATE", "the sign-off has no approval in force");
  // The approved text is the one at baseSeq, frozen; a later revision cannot
  // change what was decided.
  const snapshot = snapshotAt(events, approval.baseSeq);
  const option = snapshot.options.find((candidate) => candidate.id === approval.optionId);
  if (!option) throw new Error(`approved option ${approval.optionId} is missing from seq ${approval.baseSeq}`);
  return option;
}

export function snapshotAt(events: readonly SignoffEvent[], seq: number): SignoffSnapshot {
  let snapshot: SignoffSnapshot | undefined;
  for (const event of events) {
    if (event.seq > seq) break;
    if (event.snapshot) snapshot = event.snapshot;
  }
  if (!snapshot) throw new Error(`no snapshot at or before seq ${seq}`);
  return snapshot;
}

/** Rebuilds the head from its identity fields and the event log. */
export function rebuildHead(identity: Pick<SignoffHead, "id" | "projectKey" | "number" | "sessionId" | "source" | "orphaned" | "createdAt">, events: readonly SignoffEvent[]): SignoffHead {
  const derived = derive(events);
  const last = events[events.length - 1]!;
  return {
    ...identity,
    headSeq: last.seq,
    status: derived.status,
    assigneeIds: derived.assigneeIds,
    updatedAt: last.createdAt,
  };
}

export function displayNumber(head: Pick<SignoffHead, "number">): string {
  return `SO-${head.number}`;
}
