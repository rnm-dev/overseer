import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchAgent } from "../../cli/launchdUnits.js";

test("launchd agent restarts on failure, starts at login, and escapes paths", () => {
  const plist = buildLaunchAgent({
    label: "dev.peon.daemon",
    description: "Peon & daemon",
    peonHome: "/tmp/Peon & Sons",
    nodeBin: "/opt/homebrew/bin/node",
    script: "/tmp/Peon & Sons/dist/daemon/index.js",
    pathEnv: "/opt/a&b:/usr/bin",
    portName: "ACA_CONTROL_PORT",
    port: 4570,
    stdoutPath: "/tmp/Peon & Sons/out.log",
    stderrPath: "/tmp/Peon & Sons/err.log",
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
  assert.match(plist, /Peon &amp; daemon/);
  assert.match(plist, /\/tmp\/Peon &amp; Sons/);
  assert.match(plist, /<key>ACA_CONTROL_PORT<\/key>\s*<string>4570<\/string>/);
});
