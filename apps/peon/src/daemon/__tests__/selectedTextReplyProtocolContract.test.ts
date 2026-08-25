import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  MAX_REPLY_TO_EVENT_ID_LENGTH,
  MAX_REPLY_TO_SELECTED_TEXT_BYTES,
  MAX_REPLY_TO_SELECTED_TEXT_CHARS,
  parseReplyTo,
  ReplyToError,
} from "../sessions/replyTo.js";
import { registrationPayload } from "../overseer/peonRegistrar.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const contractRoot = path.join(repositoryRoot, "docs/protocol/selected-text-replies-v1");
const schema = JSON.parse(readFileSync(path.join(contractRoot, "schema.json"), "utf8")) as {
  $id: string;
  $defs: Record<string, Record<string, unknown>>;
};
const fixtures = JSON.parse(readFileSync(path.join(contractRoot, "fixtures.json"), "utf8")) as {
  contractVersion: number;
  capability: string;
  safeExamples: Array<{ schema: string; value: unknown }>;
  invalidExamples: Array<{ schema: string; value: unknown; error: string }>;
  sourceRules: Record<string, unknown>;
  lifecycleRules: Record<string, unknown>;
  stableErrors: Record<string, number>;
};

function definitionSchema(name: string): Record<string, unknown> {
  assert.ok(schema.$defs[name], `unknown fixture schema: ${name}`);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `${schema.$id}#/$defs/${name}`,
  };
}

test("selected-text reply fixtures validate against the canonical schema", () => {
  assert.equal(schema.$id, "urn:ovrseer:protocol:selected-text-replies-v1");
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "selected-text-replies-v1");

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

test("the runtime parser and advertised capability use the contract bounds", () => {
  assert.equal(MAX_REPLY_TO_EVENT_ID_LENGTH, 256);
  assert.equal(MAX_REPLY_TO_SELECTED_TEXT_CHARS, 8_192);
  assert.equal(MAX_REPLY_TO_SELECTED_TEXT_BYTES, 16 * 1024);
  assert.equal(fixtures.stableErrors.BAD_REPLY_TO, 400);
  assert.equal(fixtures.stableErrors.REPLY_SOURCE_NOT_FOUND, 404);
  assert.equal(fixtures.lifecycleRules.queueEditReplyToAbsent, "preserve-existing");
  assert.equal(fixtures.lifecycleRules.queueEditReplyToNull, "clear-existing");
  assert.ok(registrationPayload("00000000-0000-4000-8000-000000000001").capabilities.includes("selected-text-replies-v1"));

  const unicode = "  café\n  👩‍💻  ";
  assert.deepEqual(parseReplyTo({ eventId: "assistant_123", selectedText: unicode }), {
    eventId: "assistant_123",
    selectedText: unicode,
  });
  assert.ok(Buffer.byteLength(unicode, "utf8") <= MAX_REPLY_TO_SELECTED_TEXT_BYTES);
  assert.throws(
    () => parseReplyTo({ eventId: "assistant_123", selectedText: "x".repeat(MAX_REPLY_TO_SELECTED_TEXT_CHARS + 1) }),
    (error: unknown) => error instanceof ReplyToError && error.code === "BAD_REPLY_TO",
  );
});

test("the contract keeps authority and source eligibility explicit", () => {
  assert.deepEqual(fixtures.sourceRules.replyableTypes, ["assistant", "user_message"]);
  assert.equal(fixtures.sourceRules.sameSession, true);
  assert.equal(fixtures.sourceRules.renderOffsetsPersisted, false);
  assert.equal(fixtures.sourceRules.selectedTextIsDisplayAuthority, true);
});
