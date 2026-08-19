import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createServer, isAllowedProductionHost } from "./server.js";
import { SERVER_VERSION } from "../shared/serverVersion.js";

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

function get(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      headers: { Host: host },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
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

test("production liveness accepts an internal Host without exposing application routes", async () => {
  const port = await listen(http.createServer(createServer({ production: true })));

  const health = await get(port, "/healthz", "127.0.0.1:5000");
  assert.equal(health.status, 200);
  // The version rides on the liveness route because it is the only thing a
  // self-hosting operator can read without shell access to the host.
  assert.deepEqual(JSON.parse(health.body), { ok: true, version: SERVER_VERSION });

  const application = await get(port, "/api/account", "127.0.0.1:5000");
  assert.equal(application.status, 421);
  assert.deepEqual(JSON.parse(application.body), {
    error: "request host is not served here",
    code: "MISDIRECTED_REQUEST",
  });
});
