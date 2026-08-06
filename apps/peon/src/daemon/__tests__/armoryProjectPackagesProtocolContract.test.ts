import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../../..");
const contractRoot = path.join(repositoryRoot, "docs/protocol/armory-project-packages-v1");
const schema = JSON.parse(readFileSync(path.join(contractRoot, "schema.json"), "utf8")) as {
  $id: string;
  $defs: Record<string, Record<string, unknown>>;
};
const fixtures = JSON.parse(readFileSync(path.join(contractRoot, "fixtures.json"), "utf8")) as {
  contractVersion: number;
  capability: string;
  routes: Array<{ method: string; path: string; request?: string; response: string }>;
  safeExamples: Array<{ schema: string; value: unknown }>;
  writeOnlyExamples: Array<{ schema: string; value: unknown }>;
  stableErrors: Record<string, number>;
  migration: { rules: string[] };
};

function definitionSchema(name: string): Record<string, unknown> {
  assert.ok(schema.$defs[name], `unknown fixture schema: ${name}`);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: `${schema.$id}#/$defs/${name}`,
  };
}

function forbiddenSafeKeys(value: unknown, location = "root"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => forbiddenSafeKeys(entry, `${location}[${index}]`));
  if (!value || typeof value !== "object") return [];
  const failures: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (["values", "credentials", "enabled"].includes(key)) failures.push(`${location}.${key}`);
    failures.push(...forbiddenSafeKeys(child, `${location}.${key}`));
  }
  return failures;
}

test("Armory profile and assignment fixtures validate", () => {
  assert.equal(schema.$id, "urn:ovrseer:protocol:armory-project-packages-v1");
  assert.equal(fixtures.contractVersion, 1);
  assert.equal(fixtures.capability, "armory-project-packages-v1");

  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(schema);
  for (const example of [...fixtures.safeExamples, ...fixtures.writeOnlyExamples]) {
    const validate = ajv.compile(definitionSchema(example.schema));
    assert.equal(validate(example.value), true, `${example.schema}: ${ajv.errorsText(validate.errors)}`);
  }
});

test("safe resources contain neither values nor enablement state", () => {
  assert.deepEqual(forbiddenSafeKeys(fixtures.safeExamples), []);
  assert.equal(JSON.stringify(schema).includes('"enabled"'), false);
  assert.equal(JSON.stringify(fixtures).includes('"enabled"'), false);
});

test("typed profiles are reusable across package assignments", () => {
  const profile = fixtures.safeExamples.find(({ schema: name }) => name === "profile")!.value as {
    profileId: string;
    type: string;
  };
  const assignment = fixtures.safeExamples.find(({ schema: name, value }) =>
    name === "assignment" && (value as { profileId: string | null }).profileId !== null,
  )!.value as { profileId: string };
  assert.equal(profile.type, "google-service-account");
  assert.equal(assignment.profileId, profile.profileId);
  assert.equal("packageId" in profile, false);
});

test("one assignment shape also covers credential-free packages", () => {
  const assignments = fixtures.safeExamples
    .filter(({ schema: name }) => name === "assignment")
    .map(({ value }) => value as { profileId: string | null });
  assert.equal(assignments.some(({ profileId }) => profileId === null), true);
  assert.equal(assignments.some(({ profileId }) => typeof profileId === "string"), true);
});

test("the route contract reuses Fleet conventions without a second control plane", () => {
  assert.ok(fixtures.routes.every(({ path: routePath }) => routePath.startsWith("/api/v1/armory/")));
  assert.ok(fixtures.routes.every(({ path: routePath }) => !routePath.includes("enable") && !routePath.includes("disable")));
  assert.ok(fixtures.routes.every(({ response }) => schema.$defs[response]));
  assert.equal(JSON.stringify(schema).includes("expectedStateRevision"), false);
  assert.equal(JSON.stringify(schema).includes("nextCursor"), false);
});

test("migration preserves legacy availability without deduplicating credentials", () => {
  assert.deepEqual(fixtures.migration.rules, [
    "create-one-typed-profile-for-each-legacy-package-configuration-without-deduplicating-secrets",
    "assign-each-legacy-enabled-installed-package-to-every-existing-project",
    "assign-no-legacy-disabled-package",
    "create-no-assignment-for-new-projects-or-new-installs",
    "retain-no-enable-disable-state-after-commit",
  ]);
  assert.equal(fixtures.stableErrors.ARMORY_ACTIVATION_RETIRED, 410);
});
