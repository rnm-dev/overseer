import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createServer, isAllowedProductionHost } from "./server.js";

const servers: http.Server[] = [];
after(async () => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function postJson(port: number, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/healthz",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("JSON parser accepts composer-sized payloads beyond Express's default limit", async () => {
  const port = await listen(http.createServer(createServer()));
  const body = JSON.stringify({ prompt: "x".repeat(200_000) });

  // POST /healthz has no handler, so 404 proves parsing succeeded; 413 would
  // mean the request was rejected by the JSON parser before routing.
  assert.equal(await postJson(port, body), 404);
});

test("production host validation accepts only the configured operator origin", () => {
  const publicUrl = "https://overseer.rnm.dev";
  assert.equal(isAllowedProductionHost("overseer.rnm.dev", publicUrl), true);
  assert.equal(isAllowedProductionHost("OVERSEER.RNM.DEV.:443", publicUrl), true);
  assert.equal(isAllowedProductionHost("token.preview.overseer.rnm.dev", publicUrl), false);
  assert.equal(isAllowedProductionHost("unrelated.invalid", publicUrl), false);
  assert.equal(isAllowedProductionHost(undefined, publicUrl), false);
});
