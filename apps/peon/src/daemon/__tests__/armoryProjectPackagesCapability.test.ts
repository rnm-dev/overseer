import assert from "node:assert/strict";
import test from "node:test";
import { ARMORY_PROJECT_PACKAGES_CAPABILITY } from "../armory/index.js";
import { createDaemonCompositionRoot } from "../bootstrap/compositionRoot.js";
import { registrationPayload } from "../overseer/peonRegistrar.js";

test("armory-project-packages-v1 is advertised only with the composed storage, API, and turn runtime", () => {
  const composition = createDaemonCompositionRoot();
  assert.equal(composition.armoryApi.projectPackagesCapability, true);
  assert.ok(composition.armoryApi.projectPackages);
  assert.ok(composition.armoryRuntime);
  assert.ok(composition.armoryStores.projectPackages);
  assert.ok(registrationPayload("00000000-0000-4000-8000-000000000001").capabilities.includes(ARMORY_PROJECT_PACKAGES_CAPABILITY));
});
