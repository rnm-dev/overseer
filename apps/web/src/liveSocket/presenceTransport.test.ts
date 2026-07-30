import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const providerSource = readFileSync(
  fileURLToPath(new URL("../liveSocket.tsx", import.meta.url)),
  "utf8",
);

test("selected-workspace route presence has one publishing transport", () => {
  assert.match(providerSource, /type:\s*"presence:set"/);
  assert.doesNotMatch(
    providerSource,
    /\/workspaces\/\$\{wsId\}\/presence/,
    "an HTTP heartbeat would create a second connectionId and leave presence on both the old and new session during navigation",
  );
});
