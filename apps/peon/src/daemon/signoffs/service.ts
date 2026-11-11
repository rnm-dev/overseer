import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  approvedOption,
  derive,
  displayNumber,
  parseAssignees,
  parseMessage,
  parseResults,
  parseSnapshot,
  SignoffError,
  snapshotAt,
  TERMINAL_STATUSES,
  type SignoffAuthor,
  type SignoffEvent,
  type SignoffEventKind,
  type SignoffHead,
  type SignoffRecord,
  type SignoffSnapshot,
  type SignoffSource,
  type SignoffStatus,
} from "./model.js";
import type { SignoffStore } from "./store.js";

/** What the sign-off service needs from a session; satisfied by the session service. */
export interface SignoffSessionView {
  id: string;
  projectKey: string | null;
  origin?: "operator" | "trigger";
  trigger?: SignoffSource | null;
  status: "running" | "completed";
  settledState?: "awaiting_signoff" | null;
}

export interface SignoffSessionPort {
  get(id: string): SignoffSessionView | undefined;
  /** Queues a follow-up through the session's ordinary durable queue. */
  enqueue(sessionId: string, prompt: string, author: string, commandId: string): void;
  setSettledState(sessionId: string, state: "awaiting_signoff" | null): void;
}

export interface SignoffSummary extends SignoffHead {
  displayNumber: string;
  title: string;
}

export interface SignoffView {
  signoff: SignoffSummary;
  snapshot: SignoffSnapshot;
  events: SignoffEvent[];
}

export interface SignoffListFilter {
  status?: SignoffStatus[];
  projectKey?: string;
  sessionId?: string;
}

export type OperatorDecisionKind = "commented" | "approved" | "rejected" | "reassigned" | "withdrawn";
const OPERATOR_KINDS = new Set<OperatorDecisionKind>(["commented", "approved", "rejected", "reassigned", "withdrawn"]);
const DECIDABLE = new Set<SignoffStatus>(["pending", "changes_requested"]);

export interface OperatorDecision {
  requestId: unknown;
  kind: unknown;
  baseSeq: unknown;
  operatorId: string;
  optionId?: unknown;
  message?: unknown;
  assigneeIds?: unknown;
}

const MAX_REQUEST_ID = 128;

export class SignoffService {
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly store: SignoffStore,
    private readonly sessions: SignoffSessionPort,
    private readonly now: () => number = Date.now,
  ) {}

  // --- lifecycle -------------------------------------------------------------

  /** Loads the store and closes every execution a restart cut short. */
  restore(): void {
    this.store.load();
    for (const record of this.store.list()) {
      if (record.head.status === "executing") this.interrupt(record);
    }
  }

  /**
   * Runs as a turn settles, before the session is persisted: an execution the
   * turn left open is closed as interrupted, and the session is marked as
   * awaiting a sign-off while one of its sign-offs waits on a person.
   */
  onTurnSettled(session: { id: string; settledState?: "awaiting_signoff" | null }): void {
    for (const record of this.forSession(session.id)) {
      if (record.head.status === "executing") this.interrupt(record);
    }
    session.settledState = this.awaitingPerson(session.id) ? "awaiting_signoff" : null;
  }

  /** After sessions are restored: a sign-off whose session is gone is orphaned. */
  reconcileOrphans(): void {
    for (const record of this.store.list()) {
      if (!record.head.orphaned && !this.sessions.get(record.head.sessionId)) this.onSessionDeleted(record.head.sessionId);
    }
  }

  /** A deleted session keeps its sign-offs, marked orphaned. */
  onSessionDeleted(sessionId: string): void {
    for (const record of this.forSession(sessionId)) {
      const updated = this.store.markOrphaned(record.head.id);
      if (updated) this.publish(updated);
    }
  }

  subscribe(listener: (summary: SignoffSummary) => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  // --- reads ------------------------------------------------------------------

  list(filter: SignoffListFilter = {}): SignoffSummary[] {
    return this.store.list()
      .filter((record) => !filter.sessionId || record.head.sessionId === filter.sessionId)
      .filter((record) => !filter.projectKey || record.head.projectKey === filter.projectKey)
      .filter((record) => !filter.status?.length || filter.status.includes(record.head.status))
      .sort((a, b) => b.head.updatedAt - a.head.updatedAt || b.head.number - a.head.number)
      .map(summarize);
  }

  get(id: string): SignoffView {
    return view(this.require(id));
  }

  // --- agent tools ------------------------------------------------------------

  propose(sessionId: string, input: Record<string, unknown>): SignoffView {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SignoffError("SIGNOFF_SESSION_GONE", "the session no longer exists");
    if (session.origin !== "trigger") {
      throw new SignoffError(
        "SIGNOFF_NOT_ALLOWED",
        "Sign-offs are only for sessions started by a trigger. A person is in this chat: ask them directly.",
      );
    }
    const snapshot = parseSnapshot(input);
    const at = this.now();
    const projectKey = session.projectKey ?? null;
    const head: SignoffHead = {
      id: randomUUID(),
      projectKey,
      number: this.nextNumber(projectKey),
      sessionId,
      source: session.trigger ?? null,
      headSeq: 1,
      status: "pending",
      assigneeIds: snapshot.assignees,
      orphaned: false,
      createdAt: at,
      updatedAt: at,
    };
    const record = this.store.create(head, {
      seq: 1, author: agent(sessionId), kind: "proposed", baseSeq: null, snapshot, createdAt: at,
    });
    this.publish(record);
    return view(record);
  }

  agentList(sessionId: string, input: Record<string, unknown> = {}): SignoffSummary[] {
    const status = typeof input.status === "string" ? [input.status as SignoffStatus] : undefined;
    return this.list({ sessionId, status });
  }

  agentGet(sessionId: string, input: Record<string, unknown>): SignoffView {
    return view(this.owned(sessionId, input.signoffId));
  }

  revise(sessionId: string, input: Record<string, unknown>): SignoffView {
    const record = this.owned(sessionId, input.signoffId);
    this.assertOpen(record);
    if (!["pending", "changes_requested", "approved"].includes(record.head.status)) {
      throw new SignoffError("SIGNOFF_STATE", `cannot revise a sign-off that is ${record.head.status}`);
    }
    const snapshot = parseSnapshot(input.snapshot);
    const message = parseMessage(input.message, true);
    return view(this.append(record, { author: agent(sessionId), kind: "revised", baseSeq: record.head.headSeq, snapshot, message }));
  }

  answer(sessionId: string, input: Record<string, unknown>): SignoffView {
    const record = this.owned(sessionId, input.signoffId);
    this.assertOpen(record);
    if (!DECIDABLE.has(record.head.status)) {
      throw new SignoffError("SIGNOFF_STATE", `cannot answer a sign-off that is ${record.head.status}`);
    }
    const message = parseMessage(input.message, true);
    return view(this.append(record, { author: agent(sessionId), kind: "answered", baseSeq: record.head.headSeq, message }));
  }

  withdraw(sessionId: string, input: Record<string, unknown>): SignoffView {
    const record = this.owned(sessionId, input.signoffId);
    this.assertOpen(record);
    const message = parseMessage(input.message, false);
    let supersededBy: string | undefined;
    if (input.supersededBy !== undefined) {
      const replacement = this.owned(sessionId, input.supersededBy);
      if (replacement.head.id === record.head.id) throw new SignoffError("BAD_REQUEST", "a sign-off cannot supersede itself");
      supersededBy = replacement.head.id;
    }
    return view(this.append(record, {
      author: agent(sessionId),
      kind: supersededBy ? "superseded" : "withdrawn",
      baseSeq: record.head.headSeq,
      ...(message ? { message } : {}),
      ...(supersededBy ? { supersededBy } : {}),
    }));
  }

  executing(sessionId: string, input: Record<string, unknown>): SignoffView {
    const record = this.owned(sessionId, input.signoffId);
    if (record.head.status !== "approved") {
      throw new SignoffError("SIGNOFF_STATE", `only an approved sign-off can start executing; it is ${record.head.status}`);
    }
    const approval = derive(record.events).approval!;
    this.assertApprovedBase(record, approval, input.baseSeq);
    return view(this.append(record, { author: agent(sessionId), kind: "executing", baseSeq: approval.baseSeq }));
  }

  executed(sessionId: string, input: Record<string, unknown>): SignoffView {
    const record = this.owned(sessionId, input.signoffId);
    if (record.head.status !== "executing") {
      throw new SignoffError("SIGNOFF_STATE", `executed requires a prior executing; the sign-off is ${record.head.status}`);
    }
    const derived = derive(record.events);
    const approval = derived.approval!;
    this.assertApprovedBase(record, approval, input.baseSeq);
    const results = parseResults(input.results, approvedOption(derived, record.events));
    const message = parseMessage(input.message, false);
    return view(this.append(record, {
      author: agent(sessionId), kind: "executed", baseSeq: approval.baseSeq, results, ...(message ? { message } : {}),
    }));
  }

  // --- operator decisions -----------------------------------------------------

  decide(id: string, input: OperatorDecision): SignoffView & { replayed: boolean } {
    const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
    if (!requestId || requestId.length > MAX_REQUEST_ID) throw new SignoffError("BAD_REQUEST", `requestId is required (at most ${MAX_REQUEST_ID} characters)`);
    if (!OPERATOR_KINDS.has(input.kind as OperatorDecisionKind)) {
      throw new SignoffError("BAD_REQUEST", `kind must be one of: ${[...OPERATOR_KINDS].join(", ")}`);
    }
    const kind = input.kind as OperatorDecisionKind;
    if (!input.operatorId) throw new SignoffError("BAD_REQUEST", "the deciding operator is required");
    let record = this.require(id);

    // A retried request is the same request: answer it from what it wrote.
    const previous = record.events.find((event) => event.requestId === requestId);
    if (previous) {
      if (previous.kind !== kind) throw new SignoffError("IDEMPOTENCY_CONFLICT", "requestId was already used for a different decision");
      return { ...view(record), replayed: true };
    }

    const session = this.sessions.get(record.head.sessionId);
    if (!session && !record.head.orphaned) {
      record = this.store.markOrphaned(id) ?? record;
      this.publish(record);
    }
    if (record.head.orphaned && kind !== "withdrawn") {
      throw new SignoffError("SIGNOFF_SESSION_GONE", `${displayNumber(record.head)} belongs to a session that no longer exists; no decision can be delivered`);
    }
    this.assertOpen(record);
    if (input.baseSeq !== record.head.headSeq) {
      throw new SignoffError("SIGNOFF_CHANGED", `${displayNumber(record.head)} changed, take another look`);
    }

    const author: SignoffAuthor = { type: "operator", id: input.operatorId };
    const base = { author, kind, baseSeq: record.head.headSeq, requestId };
    let event: Omit<SignoffEvent, "seq" | "createdAt">;
    if (kind === "approved" || kind === "commented" || kind === "rejected") {
      if (!DECIDABLE.has(record.head.status)) {
        throw new SignoffError("SIGNOFF_STATE", `${displayNumber(record.head)} is ${record.head.status} and cannot be ${kind}`);
      }
    }
    if (kind === "approved") {
      const optionId = typeof input.optionId === "string" ? input.optionId : "";
      const snapshot = derive(record.events).snapshot;
      if (!snapshot.options.some((option) => option.id === optionId)) throw new SignoffError("BAD_REQUEST", "optionId does not name an option of this sign-off");
      const message = parseMessage(input.message, false);
      event = { ...base, optionId, ...(message ? { message } : {}) };
    } else if (kind === "commented") {
      event = { ...base, message: parseMessage(input.message, true) };
    } else if (kind === "reassigned") {
      if (input.assigneeIds === undefined) throw new SignoffError("BAD_REQUEST", "assigneeIds is required");
      const message = parseMessage(input.message, false);
      event = { ...base, assigneeIds: parseAssignees(input.assigneeIds, "assigneeIds"), ...(message ? { message } : {}) };
    } else {
      const message = parseMessage(input.message, false);
      event = { ...base, ...(message ? { message } : {}) };
    }

    record = this.append(record, event);
    const appended = record.events[record.events.length - 1]!;
    if (kind === "approved" || kind === "commented") {
      this.sessions.enqueue(record.head.sessionId, decisionPrompt(record, appended), input.operatorId, `signoff:${record.head.id}:${appended.seq}`);
    }
    this.refreshSettled(record.head.sessionId);
    return { ...view(record), replayed: false };
  }

  // --- internals --------------------------------------------------------------

  private append(record: SignoffRecord, event: Omit<SignoffEvent, "seq" | "createdAt">): SignoffRecord {
    const updated = this.store.append(record.head.id, { ...event, seq: record.head.headSeq + 1, createdAt: this.now() } as SignoffEvent);
    this.publish(updated);
    return updated;
  }

  private interrupt(record: SignoffRecord): void {
    const option = approvedOption(derive(record.events), record.events);
    this.append(record, {
      author: { type: "peon" },
      kind: "interrupted",
      baseSeq: derive(record.events).approval?.baseSeq ?? null,
      message: "The session stopped while executing. Check whether each action happened.",
      results: option.actions.map((action) => ({ actionId: action.id, outcome: "unknown" as const, note: "check whether it happened" })),
    });
  }

  private refreshSettled(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "completed") return;
    this.sessions.setSettledState(sessionId, this.awaitingPerson(sessionId) ? "awaiting_signoff" : null);
  }

  private awaitingPerson(sessionId: string): boolean {
    return this.forSession(sessionId).some((record) => record.head.status === "pending");
  }

  private forSession(sessionId: string): SignoffRecord[] {
    return this.store.list().filter((record) => record.head.sessionId === sessionId);
  }

  private nextNumber(projectKey: string | null): number {
    let max = 0;
    for (const record of this.store.list()) {
      if (record.head.projectKey === projectKey && record.head.number > max) max = record.head.number;
    }
    return max + 1;
  }

  private require(id: unknown): SignoffRecord {
    const record = typeof id === "string" ? this.store.get(id) : undefined;
    if (!record) throw new SignoffError("UNKNOWN_SIGNOFF", "unknown sign-off");
    return record;
  }

  /** An agent may only touch the sign-offs its own session proposed. */
  private owned(sessionId: string, id: unknown): SignoffRecord {
    if (typeof id !== "string" || !id) throw new SignoffError("BAD_REQUEST", "signoffId is required");
    const record = this.store.get(id);
    if (!record || record.head.sessionId !== sessionId) throw new SignoffError("UNKNOWN_SIGNOFF", "no such sign-off in this session");
    return record;
  }

  private assertOpen(record: SignoffRecord): void {
    if (record.head.status === "executing") {
      throw new SignoffError("SIGNOFF_STATE", `${displayNumber(record.head)} is executing; nothing can change it until it is executed`);
    }
    if (TERMINAL_STATUSES.has(record.head.status)) {
      throw new SignoffError("SIGNOFF_STATE", `${displayNumber(record.head)} is ${record.head.status} and can no longer change; propose a new sign-off instead`);
    }
  }

  private assertApprovedBase(record: SignoffRecord, approval: SignoffEvent, baseSeq: unknown): void {
    if (baseSeq !== approval.baseSeq) {
      throw new SignoffError("SIGNOFF_CHANGED", `${displayNumber(record.head)} was approved at seq ${approval.baseSeq}; pass that baseSeq`);
    }
  }

  private publish(record: SignoffRecord): void {
    this.emitter.emit("change", summarize(record));
  }
}

function agent(sessionId: string): SignoffAuthor {
  return { type: "agent", sessionId };
}

function summarize(record: SignoffRecord): SignoffSummary {
  return { ...record.head, displayNumber: displayNumber(record.head), title: derive(record.events).snapshot.title };
}

function view(record: SignoffRecord): SignoffView {
  return { signoff: summarize(record), snapshot: derive(record.events).snapshot, events: [...record.events] };
}

/** The follow-up text. An approval carries the option exactly as it stood at baseSeq. */
export function decisionPrompt(record: SignoffRecord, event: SignoffEvent): string {
  const ref = `${displayNumber(record.head)} (signoffId ${record.head.id})`;
  if (event.kind === "commented") {
    return [
      `Sign-off ${ref} received a comment at seq ${event.seq}:`,
      "",
      event.message ?? "",
      "",
      "Reply with signoff_answer, or change the proposal with signoff_revise.",
    ].join("\n");
  }
  const snapshot = snapshotAt(record.events, event.baseSeq!);
  const option = snapshot.options.find((candidate) => candidate.id === event.optionId)!;
  const actions = option.actions.map((action) => `- [${action.id}] ${action.summary}${action.detail ? `\n  ${action.detail.replaceAll("\n", "\n  ")}` : ""}`);
  return [
    `Sign-off ${ref} "${snapshot.title}" was approved: option "${option.label}" [${option.id}], as it stood at seq ${event.baseSeq}.`,
    ...(event.message ? ["", `Note from the approver: ${event.message}`] : []),
    "",
    "Approved actions (this text is the instruction; do not reread a newer version):",
    ...actions,
    "",
    `Call signoff_executing with baseSeq ${event.baseSeq} before acting, carry out the actions, then call signoff_executed with baseSeq ${event.baseSeq} and a result for every action.`,
  ].join("\n");
}
