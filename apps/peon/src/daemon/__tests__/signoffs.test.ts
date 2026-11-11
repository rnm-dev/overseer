import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  derive,
  SignoffError,
  SignoffService,
  SignoffStore,
  type SignoffEvent,
  type SignoffSessionPort,
  type SignoffSessionView,
} from "../signoffs/index.js";

const snapshot = {
  title: "Refund order 1042",
  summary: "The customer asks for a refund outside the 30-day window.",
  options: [
    { id: "refund", label: "Refund in full", recommended: true, actions: [
      { id: "issue", summary: "Issue a full refund of 49 EUR" },
      { id: "reply", summary: "Reply to the customer", detail: "Hello, your refund is on its way." },
    ] },
    { id: "credit", label: "Offer store credit", actions: [{ id: "credit", summary: "Grant 49 EUR store credit" }] },
  ],
  assignees: ["owner@example.com"],
  context: ["Customer: I'd like my money back for order 1042."],
};

class FakeSessions implements SignoffSessionPort {
  sessions = new Map<string, SignoffSessionView>();
  queued: Array<{ sessionId: string; prompt: string; author: string; commandId: string }> = [];
  settled = new Map<string, "awaiting_signoff" | null>();

  add(id: string, origin: "operator" | "trigger", status: "running" | "completed" = "running"): SignoffSessionView {
    const session: SignoffSessionView = { id, projectKey: "shop", origin, status, trigger: origin === "trigger" ? { id: "t1", source: "telegram", correlationId: "c-1" } : null };
    this.sessions.set(id, session);
    return session;
  }
  get(id: string) { return this.sessions.get(id); }
  enqueue(sessionId: string, prompt: string, author: string, commandId: string) { this.queued.push({ sessionId, prompt, author, commandId }); }
  setSettledState(sessionId: string, state: "awaiting_signoff" | null) { this.settled.set(sessionId, state); }
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-signoffs-"));
  const port = new FakeSessions();
  let clock = 1_000;
  const service = new SignoffService(new SignoffStore(dir), port, () => clock++);
  service.restore();
  return { dir, port, service };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SignoffError) return error.code;
    throw error;
  }
  assert.fail("expected a SignoffError");
}

function decide(service: SignoffService, id: string, kind: string, baseSeq: number, extra: Record<string, unknown> = {}) {
  return service.decide(id, { requestId: `${kind}-${baseSeq}-${Math.random()}`, kind, baseSeq, operatorId: "op-1", ...extra });
}

test("an operator-origin session cannot propose", () => {
  const { port, service } = setup();
  port.add("chat", "operator");
  assert.equal(code(() => service.propose("chat", snapshot)), "SIGNOFF_NOT_ALLOWED");
  assert.equal(service.list().length, 0);
});

test("propose numbers per project and stamps the trigger source", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  const first = service.propose("s1", snapshot);
  const second = service.propose("s1", { ...snapshot, title: "Second" });
  assert.equal(first.signoff.displayNumber, "SO-1");
  assert.equal(second.signoff.number, 2);
  assert.equal(first.signoff.status, "pending");
  assert.deepEqual(first.signoff.source, { id: "t1", source: "telegram", correlationId: "c-1" });
  assert.deepEqual(first.signoff.assigneeIds, ["owner@example.com"]);
});

test("snapshot validation enforces limits", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  assert.equal(code(() => service.propose("s1", { ...snapshot, options: [] })), "BAD_REQUEST");
  assert.equal(code(() => service.propose("s1", { ...snapshot, options: [{ id: "x", label: "Nothing", actions: [] }] })), "BAD_REQUEST");
  assert.equal(code(() => service.propose("s1", { ...snapshot, title: "x".repeat(201) })), "BAD_REQUEST");
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: "L", actions: [{ id: "a", summary: "s" }] }));
  assert.equal(code(() => service.propose("s1", { ...snapshot, options: many })), "BAD_REQUEST");
  const dup = [{ id: "o", label: "L", actions: [{ id: "a", summary: "s" }] }, { id: "o", label: "M", actions: [{ id: "a", summary: "s" }] }];
  assert.equal(code(() => service.propose("s1", { ...snapshot, options: dup })), "BAD_REQUEST");
});

test("full loop: comment, revise, approve, executing, executed", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  const id = service.propose("s1", snapshot).signoff.id;

  let v = decide(service, id, "commented", 1, { message: "Refund only 40 EUR, shipping is not refundable." });
  assert.equal(v.signoff.status, "changes_requested");
  assert.equal(port.queued.length, 1);
  assert.match(port.queued[0]!.prompt, /received a comment/);
  assert.equal(port.queued[0]!.commandId, `signoff:${id}:2`);

  v = service.revise("s1", { signoffId: id, message: "Refund 40 EUR", snapshot: { ...snapshot, options: [{ ...snapshot.options[0]!, actions: [{ id: "issue", summary: "Issue a refund of 40 EUR" }] }] } });
  assert.equal(v.signoff.status, "pending");
  assert.equal(v.signoff.headSeq, 3);

  v = decide(service, id, "approved", 3, { optionId: "refund" });
  assert.equal(v.signoff.status, "approved");
  const approval = port.queued[1]!;
  assert.match(approval.prompt, /Issue a refund of 40 EUR/);
  assert.match(approval.prompt, /baseSeq 3/);
  assert.equal(approval.author, "op-1");

  assert.equal(code(() => service.executed("s1", { signoffId: id, baseSeq: 3, results: [{ actionId: "issue", outcome: "done" }] })), "SIGNOFF_STATE");
  assert.equal(code(() => service.executing("s1", { signoffId: id, baseSeq: 1 })), "SIGNOFF_CHANGED");
  v = service.executing("s1", { signoffId: id, baseSeq: 3 });
  assert.equal(v.signoff.status, "executing");
  assert.equal(code(() => service.revise("s1", { signoffId: id, message: "m", snapshot })), "SIGNOFF_STATE");
  assert.equal(code(() => service.withdraw("s1", { signoffId: id })), "SIGNOFF_STATE");
  assert.equal(code(() => decide(service, id, "rejected", v.signoff.headSeq)), "SIGNOFF_STATE");
  // Results are validated against the option as approved, not the newest text.
  assert.equal(code(() => service.executed("s1", { signoffId: id, baseSeq: 3, results: [{ actionId: "reply", outcome: "done" }] })), "BAD_REQUEST");
  v = service.executed("s1", { signoffId: id, baseSeq: 3, results: [{ actionId: "issue", outcome: "done" }] });
  assert.equal(v.signoff.status, "done");
  assert.equal(code(() => service.answer("s1", { signoffId: id, message: "late" })), "SIGNOFF_STATE");
  assert.equal(code(() => service.executed("s1", { signoffId: id, baseSeq: 3, results: [{ actionId: "issue", outcome: "done" }] })), "SIGNOFF_STATE");
  assert.deepEqual(v.events.map((event) => event.kind), ["proposed", "commented", "revised", "approved", "executing", "executed"]);
});

test("a stale decision is refused and of two approvals exactly one wins", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  const id = service.propose("s1", snapshot).signoff.id;
  service.answer("s1", { signoffId: id, message: "Added context." });
  assert.equal(code(() => decide(service, id, "approved", 1, { optionId: "refund" })), "SIGNOFF_CHANGED");
  const results = ["refund", "credit"].map((optionId) => {
    try {
      return decide(service, id, "approved", 2, { optionId }).signoff.status;
    } catch (error) {
      return (error as SignoffError).code;
    }
  });
  assert.deepEqual(results, ["approved", "SIGNOFF_CHANGED"]);
  assert.equal(port.queued.length, 1);
});

test("decisions are idempotent by request id", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  const id = service.propose("s1", snapshot).signoff.id;
  const request = { requestId: "req-1", kind: "approved", baseSeq: 1, operatorId: "op", optionId: "credit" };
  const first = service.decide(id, request);
  const retry = service.decide(id, request);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.signoff.headSeq, 2);
  assert.equal(port.queued.length, 1);
  assert.equal(code(() => service.decide(id, { ...request, kind: "rejected" })), "IDEMPOTENCY_CONFLICT");
});

test("a decision for a deleted session is refused and the sign-off stays, orphaned", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  const id = service.propose("s1", snapshot).signoff.id;
  port.sessions.delete("s1");
  service.onSessionDeleted("s1");
  assert.equal(service.get(id).signoff.orphaned, true);
  assert.equal(code(() => decide(service, id, "approved", 1, { optionId: "refund" })), "SIGNOFF_SESSION_GONE");
  assert.equal(port.queued.length, 0);
  assert.equal(decide(service, id, "withdrawn", 1).signoff.status, "withdrawn");
});

test("agents only see their own session's sign-offs", () => {
  const { port, service } = setup();
  port.add("s1", "trigger");
  port.add("s2", "operator");
  const id = service.propose("s1", snapshot).signoff.id;
  assert.equal(code(() => service.agentGet("s2", { signoffId: id })), "UNKNOWN_SIGNOFF");
  assert.equal(service.agentList("s2").length, 0);
  assert.equal(service.agentList("s1").length, 1);
});

test("a settled turn marks the session awaiting a sign-off; an open execution is interrupted", () => {
  const { port, service } = setup();
  const session = port.add("s1", "trigger");
  const id = service.propose("s1", snapshot).signoff.id;
  const record: { id: string; settledState?: "awaiting_signoff" | null } = { id: "s1" };
  service.onTurnSettled(record);
  assert.equal(record.settledState, "awaiting_signoff");

  session.status = "completed";
  decide(service, id, "approved", 1, { optionId: "refund" });
  assert.equal(port.settled.get("s1"), null);
  service.executing("s1", { signoffId: id, baseSeq: 1 });
  service.onTurnSettled(record);
  const view = service.get(id);
  assert.equal(view.signoff.status, "interrupted");
  assert.deepEqual(view.events.at(-1)?.results?.map((result) => result.outcome), ["unknown", "unknown"]);
  assert.equal(record.settledState, null);
});

test("a restart during executing ends as interrupted", () => {
  const { dir, port, service } = setup();
  port.add("s1", "trigger");
  const id = service.propose("s1", snapshot).signoff.id;
  decide(service, id, "approved", 1, { optionId: "credit" });
  service.executing("s1", { signoffId: id, baseSeq: 1 });

  const restarted = new SignoffService(new SignoffStore(dir), port);
  restarted.restore();
  const view = restarted.get(id);
  assert.equal(view.signoff.status, "interrupted");
  assert.equal(view.events.at(-1)?.author.type, "peon");
  assert.match(view.events.at(-1)?.results?.[0]?.note ?? "", /check whether it happened/);
});

test("the log is append-only and the head is rebuilt from it", () => {
  const { dir, port, service } = setup();
  port.add("s1", "trigger");
  const view = service.propose("s1", snapshot);
  const id = view.signoff.id;
  const store = new SignoffStore(dir);
  store.load();
  const stored = store.get(id)!;
  assert.throws(() => { (stored.events as SignoffEvent[]).push(stored.events[0]!); });
  assert.throws(() => { (stored.events[0] as { kind: string }).kind = "approved"; });
  assert.throws(() => store.append(id, { ...stored.events[0]!, seq: 1 }), /append-only/);
  assert.throws(() => store.append(id, { ...stored.events[0]!, kind: "answered", seq: 3 }), /append-only/);

  // A tampered head is ignored on load: status comes from the events.
  const file = path.join(dir, `${id}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.head.status = "done";
  raw.head.headSeq = 99;
  writeFileSync(file, JSON.stringify(raw));
  store.load();
  assert.equal(store.get(id)!.head.status, "pending");
  assert.equal(store.get(id)!.head.headSeq, 1);
});

test("derived status covers every outcome of executed", () => {
  const base: SignoffEvent[] = [
    { seq: 1, author: { type: "agent", sessionId: "s" }, kind: "proposed", baseSeq: null, snapshot: { ...snapshot, options: snapshot.options.map((o) => ({ ...o, actions: o.actions.map((a) => ({ ...a, type: "freeform" as const })) })) }, createdAt: 1 },
    { seq: 2, author: { type: "operator", id: "o" }, kind: "approved", baseSeq: 1, optionId: "refund", createdAt: 2 },
    { seq: 3, author: { type: "agent", sessionId: "s" }, kind: "executing", baseSeq: 1, createdAt: 3 },
  ];
  const executed = (outcomes: Array<"done" | "failed" | "skipped">) => derive([...base, {
    seq: 4, author: { type: "agent", sessionId: "s" }, kind: "executed", baseSeq: 1, createdAt: 4,
    results: outcomes.map((outcome, i) => ({ actionId: ["issue", "reply"][i]!, outcome })),
  }]).status;
  assert.equal(executed(["done", "done"]), "done");
  assert.equal(executed(["done", "failed"]), "partly_done");
  assert.equal(executed(["failed", "skipped"]), "failed");
  assert.equal(derive(base).status, "executing");
  assert.equal(derive(base.slice(0, 1)).status, "pending");
  assert.equal(derive([...base.slice(0, 1), { seq: 2, author: { type: "operator", id: "o" }, kind: "reassigned", baseSeq: 1, assigneeIds: ["b"], createdAt: 2 }]).assigneeIds[0], "b");
});
