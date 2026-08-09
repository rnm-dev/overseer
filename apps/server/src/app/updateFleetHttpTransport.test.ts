import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("Peon update routes have one direct Fleet HTTP authority", () => {
  const source = readFileSync(path.join(import.meta.dirname, "..", "routes/peons/sessions.ts"), "utf8");
  const start = source.indexOf('router.post(`${wp}/control/check-update`');
  const end = source.indexOf('router.get(`${wp}/ai/cli-updates`', start);
  assert.ok(start >= 0 && end > start);
  const updateRoutes = source.slice(start, end);

  assert.match(updateRoutes, /callPeon\(connOfRecord\(c\.record\), "POST", "\/control\/check-update"/);
  assert.match(updateRoutes, /callPeon\(connOfRecord\(c\.record\), "POST", "\/control\/update"/);
  assert.doesNotMatch(updateRoutes, /latestRelease|release:/);
  assert.match(updateRoutes, /body: req\.body\?\.force === true \? \{ force: true \} : \{\}/);
  assert.doesNotMatch(updateRoutes, /reverseCommand|runReverseCommandTransport|fallback|legacy/);
});
