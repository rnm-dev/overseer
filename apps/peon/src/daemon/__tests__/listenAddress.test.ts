import assert from "node:assert/strict";
import test from "node:test";
import { parseListenAddress } from "../../shared/listenAddress.js";

test("listen address requires a host and explicit port", () => {
  assert.deepEqual(parseListenAddress("0.0.0.0:4570"), {
    host: "0.0.0.0",
    port: 4570,
    canonical: "0.0.0.0:4570",
  });
  assert.deepEqual(parseListenAddress("[::1]:4580"), {
    host: "::1",
    port: 4580,
    canonical: "[::1]:4580",
  });
  assert.throws(() => parseListenAddress("0.0.0.0"), /host:port/);
  assert.throws(() => parseListenAddress("https://0.0.0.0:4570"), /host:port/);
  assert.throws(() => parseListenAddress("0.0.0.0:70000"), /host:port|between 1 and 65535/);
});
