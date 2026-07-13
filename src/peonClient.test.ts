import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createServer } from "./server.js";
import { callPeon, normalizePeonUrl, normalizeProxyError } from "./peonClient.js";

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

test("recruitment URLs normalize a trailing unified API path", () => {
  assert.equal(normalizePeonUrl("peon.test:4570/api/v1/"), "http://peon.test:4570");
  assert.equal(normalizePeonUrl("https://peon.test/base/api/v1"), "https://peon.test/base");
  assert.equal(normalizePeonUrl("not a url"), null);
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
