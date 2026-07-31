import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DAEMON_LAUNCHD_LABEL,
  DAEMON_SYSTEMD_UNIT,
  daemonRestartCommand,
  daemonStatusCommand,
} from "../../cli/serviceControl.js";
import { backgroundSupervisor } from "../../shared/backgroundSupervisor.js";
import { SECURE_FILE_HELPER } from "../../shared/runtimePrerequisites.js";

test("global updater uses platform-native supervision", () => {
  assert.equal(backgroundSupervisor(false, "darwin"), "detached");
  assert.equal(backgroundSupervisor(false, "linux"), "systemd");
  assert.equal(backgroundSupervisor(true, "darwin"), "detached");
  assert.equal(backgroundSupervisor(true, "linux"), "detached");
});

test("daemon restart uses launchd on macOS", () => {
  assert.deepEqual(daemonRestartCommand("darwin", 501), {
    command: "launchctl",
    args: ["kickstart", "-k", `gui/501/${DAEMON_LAUNCHD_LABEL}`],
    displayName: DAEMON_LAUNCHD_LABEL,
  });
});

test("daemon status uses launchd on macOS", () => {
  assert.deepEqual(daemonStatusCommand("darwin", 501), {
    command: "launchctl",
    args: ["print", `gui/501/${DAEMON_LAUNCHD_LABEL}`],
    displayName: DAEMON_LAUNCHD_LABEL,
  });
});

test("daemon service control uses systemd on Linux", () => {
  assert.deepEqual(daemonRestartCommand("linux", 501), {
    command: "systemctl",
    args: ["--user", "restart", DAEMON_SYSTEMD_UNIT],
    displayName: DAEMON_SYSTEMD_UNIT,
  });
  assert.deepEqual(daemonStatusCommand("linux", 501), {
    command: "systemctl",
    args: ["--user", "status", DAEMON_SYSTEMD_UNIT, "--no-pager"],
    displayName: DAEMON_SYSTEMD_UNIT,
  });
});

test("secure file helper has a stable absolute path", () => {
  assert.equal(SECURE_FILE_HELPER, "/usr/bin/python3");
});
