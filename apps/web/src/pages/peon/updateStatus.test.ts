import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUpdateStatus } from "./updateStatus";

test("flat GET /status fields are read as they are", () => {
  const status = normalizeUpdateStatus({
    updateAvailable: true,
    updateCurrentVersion: "0.11.3",
    updateLatestVersion: "0.12.0",
    updateCurrentRevision: "abc",
    updateLatestRevision: "def",
    updateCheckedAt: 1_700_000_000_000,
    updateCheckError: null,
  });
  assert.deepEqual(status, {
    updateAvailable: true,
    updateCurrentVersion: "0.11.3",
    updateLatestVersion: "0.12.0",
    updateCurrentRevision: "abc",
    updateLatestRevision: "def",
    updateCheckedAt: 1_700_000_000_000,
    updateCheckError: null,
  });
});

// The explicit "Check now" action answers with a bounded envelope whose fields
// carry no `update` prefix. Reading it raw blanked out every version on screen.
test("the check-update envelope keeps the versions", () => {
  const status = normalizeUpdateStatus({
    status: "available",
    code: "OK",
    result: {
      updateAvailable: true,
      currentVersion: "0.11.3",
      latestVersion: "0.12.0",
      currentRevision: "abc",
      latestRevision: "def",
      checkedAt: 1_700_000_000_000,
      checkError: null,
    },
  });
  assert.equal(status.updateAvailable, true);
  assert.equal(status.updateCurrentVersion, "0.11.3");
  assert.equal(status.updateLatestVersion, "0.12.0");
  assert.equal(status.updateCurrentRevision, "abc");
  assert.equal(status.updateLatestRevision, "def");
  assert.equal(status.updateCheckedAt, 1_700_000_000_000);
});

test("a current peon reports no update without an explicit flag", () => {
  const status = normalizeUpdateStatus({ status: "current", code: "NO_UPDATE", result: { currentVersion: "0.12.0", latestVersion: "0.12.0" } });
  assert.equal(status.updateAvailable, false);
  assert.equal(status.updateLatestVersion, "0.12.0");
});

test("missing, blank and malformed values become null rather than dashes of their own", () => {
  const status = normalizeUpdateStatus({ result: { currentVersion: "  ", checkedAt: "2026-07-31T00:00:00.000Z", checkError: "registry unavailable" } });
  assert.equal(status.updateCurrentVersion, null);
  assert.equal(status.updateLatestVersion, null);
  assert.equal(status.updateCheckedAt, Date.parse("2026-07-31T00:00:00.000Z"));
  assert.equal(status.updateCheckError, "registry unavailable");
  assert.equal(normalizeUpdateStatus(null).updateAvailable, false);
});
