import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { peonsRouter } from "./routes/peons.js";

test("update control is exposed and its status contract is documented", async () => {
  const router = peonsRouter() as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  const updateRoute = router.stack.find(
    (layer) => layer.route?.path === "/workspaces/:wsId/peons/:id/control/update",
  );

  assert.equal(updateRoute?.route?.methods?.post, true);

  const protocol = await readFile(new URL("../PROTOCOL.md", import.meta.url), "utf8");
  for (const field of [
    "updateAvailable",
    "updateLocalSha",
    "updateRemoteSha",
    "updateCheckedAt",
    "updateCheckError",
  ]) {
    assert.match(protocol, new RegExp(`\\b${field}\\b`));
  }
});
