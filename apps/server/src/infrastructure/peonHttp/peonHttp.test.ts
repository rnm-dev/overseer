import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createServer } from "../../app/server.js";
import { callPeon, classifyPeonNetworkError, normalizePeonUrl, normalizeProxyError } from "./index.js";

const servers: http.Server[] = [];
after(async () => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function post(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("fleet calls use the unified API once and preserve protocol headers", async () => {
  const seen: { url?: string; authorization?: string; protocol?: string; actor?: string; requestId?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        protocol: req.headers["peon-protocol"] as string | undefined,
        actor: req.headers["peon-actor"] as string | undefined,
        requestId: req.headers["peon-request-id"] as string | undefined,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"protocol":1}');
    });
  });
  const port = await listen(server);
  const root = `http://127.0.0.1:${port}`;

  for (const baseUrl of [root, `${root}/api/v1`]) {
    const result = await callPeon({ baseUrl, token: "pn_test" }, "POST", "/sessions", {
      actor: "operator@example.com",
      requestId: "request-1",
      body: { prompt: "hello" },
    });
    assert.equal(result.ok, true);
  }

  assert.deepEqual(seen.map((request) => request.url), ["/api/v1/sessions", "/api/v1/sessions"]);
  assert.ok(seen.every((request) => request.authorization === "Bearer pn_test"));
  assert.ok(seen.every((request) => request.protocol === "1"));
  assert.ok(seen.every((request) => request.actor === "operator@example.com"));
  assert.ok(seen.every((request) => request.requestId === "request-1"));
  assert.ok(seen.every((request) => request.body === '{"prompt":"hello"}'));
});

test("fleet calls generate a correlation id when the caller does not supply one", async () => {
  let requestId: string | undefined;
  const server = http.createServer((req, res) => {
    requestId = req.headers["peon-request-id"] as string | undefined;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const port = await listen(server);
  const result = await callPeon({ baseUrl: `http://127.0.0.1:${port}`, token: "pn_test" }, "GET", "/status", { actor: "operator@example.com" });

  assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(result.requestId, requestId);
});

test("Armory update start and polling preserve authenticated fleet status contracts", async () => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined; protocol: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      authorization: req.headers.authorization,
      protocol: req.headers["peon-protocol"] as string | undefined,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/armory/packages/current/update") {
      res.writeHead(202).end('{"operation":{"id":"op-update","kind":"update","status":"queued"}}');
    } else if (req.url === "/api/v1/armory/operations/op-update") {
      res.writeHead(200).end('{"operation":{"id":"op-update","kind":"update","status":"success"}}');
    } else if (req.url === "/api/v1/armory/packages/missing/update") {
      res.writeHead(404).end('{"code":"PACKAGE_NOT_ACTIVE","error":"Package is not active"}');
    } else {
      res.writeHead(409).end('{"code":"NO_UPDATE_AVAILABLE","error":"No update is available"}');
    }
  });
  const port = await listen(server);
  const conn = { baseUrl: `http://127.0.0.1:${port}`, token: "pn_armory" };
  const start = await callPeon(conn, "POST", "/armory/packages/current/update", { actor: "operator@example.com", body: { version: "2.0.0" } });
  const poll = await callPeon(conn, "GET", "/armory/operations/op-update", { actor: "operator@example.com" });
  const missing = await callPeon(conn, "POST", "/armory/packages/missing/update", { actor: "operator@example.com", body: {} });
  const conflict = await callPeon(conn, "POST", "/armory/packages/current/no-update", { actor: "operator@example.com", body: {} });

  assert.equal(start.status, 202);
  assert.equal((start.json as { operation: { id: string } }).operation.id, "op-update");
  assert.equal(poll.status, 200);
  assert.equal((poll.json as { operation: { status: string } }).operation.status, "success");
  assert.deepEqual([missing.status, (missing.json as { code: string }).code], [404, "PACKAGE_NOT_ACTIVE"]);
  assert.deepEqual([conflict.status, (conflict.json as { code: string }).code], [409, "NO_UPDATE_AVAILABLE"]);
  assert.ok(seen.every((request) => request.authorization === "Bearer pn_armory" && request.protocol === "1"));
});

test("canonical Peon URLs preserve identity and reject unsafe components", () => {
  assert.equal(normalizePeonUrl("http://peon.test:4570/"), "http://peon.test:4570");
  assert.equal(normalizePeonUrl("https://peon.test:443/base/"), "https://peon.test:443/base");
  assert.equal(normalizePeonUrl("peon.test:4570"), null);
  assert.equal(normalizePeonUrl("http://user:pass@peon.test:4570"), null);
  assert.equal(normalizePeonUrl("http://peon.test:4570/?token=x"), null);
  assert.equal(normalizePeonUrl("http://peon.test:4570/#fragment"), null);
  assert.equal(normalizePeonUrl("not a url"), null);
});

test("network enrollment errors are actionable", () => {
  assert.equal(classifyPeonNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })).code, "DNS_FAILURE");
  assert.equal(classifyPeonNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })).code, "CONNECTION_REFUSED");
  assert.equal(classifyPeonNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } })).code, "TLS_FAILURE");
});

test("filesystem permission failures become a useful structured 403", () => {
  const fromLegacyPeon = normalizeProxyError(500, "EACCES: permission denied, scandir '/postgres/data'");
  assert.equal(fromLegacyPeon.status, 403);
  assert.equal(fromLegacyPeon.contentType, "application/json");
  assert.deepEqual(JSON.parse(fromLegacyPeon.body), {
    error: "Permission denied — the Peon process cannot read or write this file or directory.",
    code: "FILE_PERMISSION_DENIED",
  });

  const explicitForbidden = normalizeProxyError(403, "Forbidden", "text/plain");
  assert.equal(explicitForbidden.status, 403);
  assert.match(explicitForbidden.body, /Permission denied/);
});

test("unrelated upstream errors remain unchanged", () => {
  assert.deepEqual(normalizeProxyError(500, "database unavailable", "text/plain"), {
    status: 500,
    contentType: "text/plain",
    body: "database unavailable",
  });
});

test("north-bound fleet registration is mounted on the unified API", async () => {
  const port = await listen(http.createServer(createServer()));
  const unified = await post(port, "/api/v1/peons/register");
  assert.equal(unified.status, 401);
  assert.match(unified.body, /invalid or revoked peon credential/);
});
