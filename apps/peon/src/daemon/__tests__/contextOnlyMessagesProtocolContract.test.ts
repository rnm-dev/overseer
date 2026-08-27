import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { registrationPayload } from "../overseer/peonRegistrar.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const contractRoot = path.join(repositoryRoot, "docs/protocol/context-only-messages-v1");
const schema = JSON.parse(readFileSync(path.join(contractRoot, "schema.json"), "utf8")) as {
  $id: string;
  $defs: Record<string, Record<string, unknown>>;
};
const fixtures = JSON.parse(readFileSync(path.join(contractRoot, "fixtures.json"), "utf8")) as {
  contractVersion: number;
  capability: string;
  safeExamples: Array<{ schema: string; value: unknown }>;
  invalidExamples: Array<{ schema: string; value: unknown; error: string }>;
  bounds: Record<string, number>;
  routingRules: Record<string, unknown>;
  mentionRules: Record<string, unknown>;
  deliveryRules: Record<string, unknown>;
  providerEnvelope: {
    encoding: string;
    topLevelFieldOrder: string[];
    messageFieldOrder: string[];
    authorFieldOrder: string[];
    encodedExample: string;
    providerNativeThreading: boolean;
  };
  attentionRules: Record<string, unknown>;
  lifecycleRules: Record<string, unknown>;
  routes: Array<{ authority: string; method: string; path: string; request: string; response: string }>;
  agentMentionRoutes: Array<{
    method: string;
    path: string;
    publicRequestExtension: string;
    fleetRequestExtension: string;
    transcriptExtension: string;
  }>;
  stableErrors: Record<string, number>;
  mixedVersion: Record<string, unknown>;
};

function definitionSchema(name: string): Record<string, unknown> {
  assert.ok(schema.$defs[name], `unknown fixture schema: ${name}`);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `${schema.$id}#/$defs/${name}`,
  };
}

test("context-only message fixtures validate against the canonical schema", () => {
  assert.equal(schema.$id, "urn:ovrseer:protocol:context-only-messages-v1");
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "context-only-messages-v1");

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(schema);
  for (const example of fixtures.safeExamples) {
    const validate = ajv.compile(definitionSchema(example.schema));
    assert.equal(validate(example.value), true, `${example.schema}: ${ajv.errorsText(validate.errors)}`);
  }
  for (const example of fixtures.invalidExamples) {
    const validate = ajv.compile(definitionSchema(example.schema));
    assert.equal(validate(example.value), false, `${example.schema} unexpectedly validated`);
  }
});

test("routing is explicit and labels are server-resolved", () => {
  assert.equal(fixtures.routingRules.contextEndpointCanInvokeAgent, false);
  assert.equal(fixtures.routingRules.rawAtTextRoutesOrNotifies, false);
  assert.equal(fixtures.routingRules.agentPickerUsesExistingAgentPath, true);
  assert.equal(fixtures.routingRules.agentRequestsMayCarryHumanMentions, true);
  assert.deepEqual(fixtures.routingRules.principalKinds, ["user", "guest"]);
  assert.equal(fixtures.routingRules.clientSuppliedLabelsAccepted, false);
  assert.equal(fixtures.mentionRules.offsetUnit, "utf16-code-unit");
  assert.equal(fixtures.mentionRules.surrogatePairsMayBeSplit, false);
  assert.equal(fixtures.mentionRules.principalResolvedBy, "overseer-session-access");
});

test("delivery is bounded, complete and assigned once to a logical Peon turn", () => {
  assert.deepEqual(fixtures.bounds, {
    messageCodePoints: 8192,
    messageUtf8Bytes: 16384,
    mentionsPerMessage: 32,
    attachmentsPerMessage: 10,
    pendingMessages: 64,
    providerEnvelopeUtf8Bytes: 65536,
    mentionReadBatch: 100,
  });
  assert.equal(fixtures.deliveryRules.authority, "peon");
  assert.equal(fixtures.deliveryRules.eventMutable, false);
  assert.equal(fixtures.deliveryRules.watermarkStorage, "peon-sidecar");
  assert.equal(fixtures.deliveryRules.claimAt, "agent-turn-execution-start");
  assert.equal(fixtures.deliveryRules.queuedTurnClaimsAtAdmission, false);
  assert.equal(fixtures.deliveryRules.postedDuringActiveTurn, "next-turn");
  assert.equal(fixtures.deliveryRules.logicalExactlyOnce, "one-accepted-peon-turn");
  assert.equal(fixtures.deliveryRules.externalProviderExactlyOncePromised, false);
  assert.equal(fixtures.deliveryRules.backlogOverflow, "reject-without-truncation");
  assert.equal(fixtures.providerEnvelope.encoding, "canonical-json-utf8");
  assert.equal(fixtures.providerEnvelope.providerNativeThreading, false);
  assert.deepEqual(fixtures.providerEnvelope.topLevelFieldOrder, ["version", "kind", "messages"]);
  assert.deepEqual(fixtures.providerEnvelope.messageFieldOrder, [
    "contextSeq", "createdAt", "author", "text", "attachments", "mentions",
  ]);
  assert.deepEqual(fixtures.providerEnvelope.authorFieldOrder, ["kind", "id", "label"]);
  assert.equal(JSON.stringify(JSON.parse(fixtures.providerEnvelope.encodedExample)), fixtures.providerEnvelope.encodedExample);
});

test("human mention attention remains separate from agent completion attention", () => {
  assert.equal(fixtures.attentionRules.authority, "overseer");
  assert.equal(fixtures.attentionRules.separateFromSessionAttention, true);
  assert.deepEqual(fixtures.attentionRules.occurrenceIdentity, ["recipientPrincipal", "eventId"]);
  assert.equal(fixtures.attentionRules.acknowledgeExactEventIds, true);
  assert.equal(fixtures.attentionRules.duplicateRecipientOccurrences, "coalesced-per-event");
  assert.equal(fixtures.attentionRules.unknownOrAlreadyReadEventIds, "idempotent-no-op");
  assert.equal(fixtures.attentionRules.messageTextInPush, false);
  assert.equal(fixtures.lifecycleRules.contextMessageCountsAsAgentTurn, false);
  assert.equal(fixtures.lifecycleRules.contextMessageCreatesCompletionAttention, false);
});

test("Fleet HTTP remains authoritative and capability rollout is fail-closed", () => {
  assert.ok(fixtures.routes.every(({ request, response }) => schema.$defs[request] && schema.$defs[response]));
  const fleetRoute = fixtures.routes.find(({ authority }) => authority === "peon-fleet-http");
  assert.deepEqual(fleetRoute, {
    authority: "peon-fleet-http",
    method: "POST",
    path: "/api/v1/sessions/:id/context-messages",
    request: "fleetContextMessageRequest",
    response: "contextMessage",
    idempotency: "Peon-Request-Id",
  });
  assert.equal(fixtures.stableErrors.CONTEXT_BACKLOG_FULL, 409);
  assert.equal(fixtures.stableErrors.IDEMPOTENCY_CONFLICT, 409);
  assert.equal(fixtures.stableErrors.UNSUPPORTED_CAPABILITY, 409);
  assert.equal(fixtures.mixedVersion.advertiseOnlyWhenComplete, true);
  assert.equal(fixtures.mixedVersion.ordinaryAgentRequestsWithoutMentions, "unchanged");
  assert.ok(registrationPayload("00000000-0000-4000-8000-000000000001").capabilities.includes(fixtures.capability));
});

test("agent-invoking routes preserve normalized human mentions", () => {
  assert.deepEqual(fixtures.agentMentionRoutes.map(({ method, path: routePath }) => `${method} ${routePath}`), [
    "POST /sessions/:id/followup",
    "POST /sessions/:id/queue",
    "PATCH /sessions/:id/queue/:itemId",
  ]);
  for (const route of fixtures.agentMentionRoutes) {
    assert.ok(schema.$defs[route.publicRequestExtension]);
    assert.ok(schema.$defs[route.fleetRequestExtension]);
    assert.ok(schema.$defs[route.transcriptExtension]);
  }
  assert.ok(schema.$defs.fleetAgentMessageRequest.properties);
  assert.ok(schema.$defs.userMessage.properties);
});
