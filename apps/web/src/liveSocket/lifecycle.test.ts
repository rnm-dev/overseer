import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const providerSource = readFileSync(
  fileURLToPath(new URL("../liveSocket.tsx", import.meta.url)),
  "utf8",
);

test("socket lifecycle depends on stable user identity", () => {
  assert.match(providerSource, /const userEmail = user\?\.email;/);
  assert.match(providerSource, /\}, \[wsId, userEmail, updatePeon\]\);/);
  assert.doesNotMatch(providerSource, /\}, \[wsId, user, updatePeon\]\);/);
});

test("socket workspace is resolved from the route before connecting", () => {
  assert.match(providerSource, /const wsId = socketWorkspaceForPath\(/);
});
