import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  SIGNOFF_CATALOG_CAPABILITY,
  SIGNOFFS_CAPABILITY,
  SignoffCatalog,
  SignoffError,
  SignoffService,
  SignoffStore,
  type SignoffSessionView,
} from "../signoffs/index.js";
import { toSessionSummary } from "../sessions/sessionSummary.js";
import type { SessionRecord } from "../sessions/sessionTypes.js";

const contractRoot = path.resolve(import.meta.dirname, "../../../../../docs/protocol/session-signoffs-v1");
const schema = JSON.parse(readFileSync(path.join(contractRoot, "schema.json"), "utf8")) as { $id: string; $defs: Record<string, unknown> };
const fixtures = JSON.parse(readFileSync(path.join(contractRoot, "fixtures.json"), "utf8")) as {
  capability: string;
  projectionCapability: string;
  safeExamples: Array<{ schema: string; value: unknown }>;
  invalidExamples: Array<{ schema: string; value: unknown }>;
  stableErrors: Record<string, number>;
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);
function validator(name: string) {
  assert.ok(schema.$defs[name], `unknown schema ${name}`);
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
}
function assertValid(name: string, value: unknown) {
  const validate = validator(name);
  assert.equal(validate(value), true, `${name}: ${ajv.errorsText(validate.errors)}`);
}

test("sign-off fixtures validate against the canonical schema", () => {
  assert.equal(fixtures.capability, SIGNOFFS_CAPABILITY);
  assert.equal(fixtures.projectionCapability, SIGNOFF_CATALOG_CAPABILITY);
  for (const example of fixtures.safeExamples) assertValid(example.schema, example.value);
  for (const example of fixtures.invalidExamples) assert.equal(validator(example.schema)(example.value), false, `${example.schema} unexpectedly validated`);
});

test("stable error statuses match the implementation", () => {
  for (const [code, status] of Object.entries(fixtures.stableErrors)) {
    assert.equal(new SignoffError(code as SignoffError["code"], "x").status, status, code);
  }
});

test("what Peon actually emits conforms to the schema", () => {
  const session: SignoffSessionView = { id: "s1", projectKey: "shop", origin: "trigger", status: "running", trigger: { id: "wf", source: "email", correlationId: null } };
  const service = new SignoffService(new SignoffStore(mkdtempSync(path.join(os.tmpdir(), "peon-signoff-contract-"))), {
    get: (id) => id === "s1" ? session : undefined,
    enqueue: () => undefined,
    setSettledState: () => undefined,
  });
  const catalog = new SignoffCatalog(service);
  catalog.start();
  const frames: unknown[] = [];
  catalog.subscribe((event) => frames.push({ type: "signoff_catalog_event", epoch: catalog.epoch, ...event }));

  const proposed = service.propose("s1", {
    title: "Reply to the supplier",
    summary: "Move the delivery?",
    options: [{ id: "accept", label: "Accept", recommended: true, actions: [{ id: "reply", summary: "Reply", detail: "Friday works." }] }],
    context: "Supplier: Friday?",
  });
  const id = proposed.signoff.id;
  service.decide(id, { requestId: "r1", kind: "commented", baseSeq: 1, operatorId: "op", message: "Saturday" });
  service.answer("s1", { signoffId: id, message: "Saturday is closed." });
  service.decide(id, { requestId: "r2", kind: "approved", baseSeq: 3, operatorId: "op", optionId: "accept" });
  service.executing("s1", { signoffId: id, baseSeq: 3 });
  const done = service.executed("s1", { signoffId: id, baseSeq: 3, results: [{ actionId: "reply", outcome: "done", note: "sent" }] });

  assertValid("view", done);
  assertValid("list", { signoffs: service.list() });
  for (const frame of frames) assertValid("catalogEventFrame", frame);
  assertValid("catalogSnapshotPageFrame", { type: "signoff_catalog_snapshot_page", ...catalog.page("req", 10) });

  const summary = toSessionSummary({
    id: "x", kind: "agent", status: "completed", prompt: "p", title: null, projectKey: null, projectId: null,
    initiator: null, outcome: null, startedAt: 1, endedAt: 2, lastActivityAt: 2, lastMessagePreview: null,
    origin: "trigger", trigger: { id: null, source: "email", correlationId: "c" }, settledState: "awaiting_signoff",
  } as unknown as SessionRecord);
  assertValid("sessionOriginView", summary);
});
