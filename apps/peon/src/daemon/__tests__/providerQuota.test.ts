import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Codex quota probe uses the current non-interactive approval policy", () => {
  const source = readFileSync(new URL("../providers/providerQuota.ts", import.meta.url), "utf8");

  assert.match(source, /CODEX_QUOTA_ARGS = \["-s", "read-only", "-a", "never", "app-server"\]/);
  assert.doesNotMatch(source, /CODEX_QUOTA_ARGS = .*"untrusted"/);
});
