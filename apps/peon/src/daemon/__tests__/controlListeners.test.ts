import assert from "node:assert/strict";
import test from "node:test";
import { controlListenerHosts } from "../controlListeners.js";

test("concrete Fleet interfaces retain a private loopback listener for CLI and MCP", () => {
  assert.deepEqual(controlListenerHosts("100.64.0.3"), ["100.64.0.3", "127.0.0.1"]);
  assert.deepEqual(controlListenerHosts("peon.example.test"), ["peon.example.test", "127.0.0.1"]);
});

test("loopback and wildcard binds do not create a conflicting second listener", () => {
  assert.deepEqual(controlListenerHosts("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(controlListenerHosts("::1"), ["::1"]);
  assert.deepEqual(controlListenerHosts("0.0.0.0"), ["0.0.0.0"]);
  assert.deepEqual(controlListenerHosts("::"), ["::"]);
});
