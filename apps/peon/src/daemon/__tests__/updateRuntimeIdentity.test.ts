import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readUpdateRuntimeIdentity,
  sameUpdateReleaseIdentity,
  updateRuntimeIdentityPath,
  writeUpdateRuntimeIdentity,
} from "../updates/updateRuntimeIdentity.js";

test("replacement runtime identity preserves exact version, revision and SHA-256", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-runtime-identity-"));
  const identity = {
    version: "1.2.3",
    revision: "immutable-revision-1",
    sha256: "a".repeat(64),
  };
  try {
    writeUpdateRuntimeIdentity(root, identity);
    assert.deepEqual(readUpdateRuntimeIdentity(root), identity);

    writeFileSync(updateRuntimeIdentityPath(root), JSON.stringify({
      ...identity,
      sha256: "b".repeat(64),
      unexpected: "ignored only by unsafe parsers",
    }));
    assert.equal(readUpdateRuntimeIdentity(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval identity rejects same-version revision and SHA substitutions", () => {
  const approved = { version: "1.2.3", revision: "revision-a", sha256: "a".repeat(64) };
  assert.equal(sameUpdateReleaseIdentity(approved, approved), true);
  assert.equal(sameUpdateReleaseIdentity(approved, { ...approved, revision: "revision-b" }), false);
  assert.equal(sameUpdateReleaseIdentity(approved, { ...approved, sha256: "b".repeat(64) }), false);
});
