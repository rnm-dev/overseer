import assert from "node:assert/strict";
import test from "node:test";
import { serviceEnvPath } from "../../cli/servicePath.js";

test("appends ~/.local/bin when the install shell did not have it", () => {
  const result = serviceEnvPath("/usr/local/bin:/usr/bin", "/usr/bin:/bin", "/home/peon");
  assert.equal(result, "/usr/local/bin:/usr/bin:/home/peon/.local/bin");
});

test("keeps an operator's existing ~/.local/bin precedence", () => {
  const result = serviceEnvPath("/home/peon/.local/bin:/usr/bin", "/usr/bin:/bin", "/home/peon");
  assert.equal(result, "/home/peon/.local/bin:/usr/bin");
});

test("falls back to the platform default when PATH is unset or blank", () => {
  assert.equal(
    serviceEnvPath(undefined, "/usr/local/bin:/usr/bin:/bin", "/home/peon"),
    "/usr/local/bin:/usr/bin:/bin:/home/peon/.local/bin",
  );
  assert.equal(
    serviceEnvPath("   ", "/usr/bin:/bin", "/home/peon"),
    "/usr/bin:/bin:/home/peon/.local/bin",
  );
});

test("drops empty entries so the unit never carries an implicit current directory", () => {
  const result = serviceEnvPath("/usr/bin::/bin:", "/usr/bin", "/home/peon");
  assert.equal(result, "/usr/bin:/bin:/home/peon/.local/bin");
});
