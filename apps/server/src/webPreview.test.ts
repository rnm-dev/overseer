import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { newDb } from "pg-mem";
import { setPool } from "./db.js";
import { registry } from "./registry.js";
import { createServer } from "./server.js";
import { mintWebPreview } from "./webPreview.js";

const servers: http.Server[] = [];
after(async () => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function rawRequest(port: number, host: string, requestPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, headers: { Host: host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("HTML preview grants proxy a rooted asset tree without exposing Peon credentials", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  setPool(new adapter.Pool() as unknown as pg.Pool);
  mem.public.none(`CREATE TABLE peons (
    peon_id text primary key, credential_id text not null, workspace_id text not null,
    name text not null, hostname text, address text not null, control_port integer not null,
    protocol integer, capabilities jsonb, token text not null, connection_pinned boolean default false,
    load jsonb, registered_at bigint not null, last_seen bigint not null,
    public_url text, address_source text not null default 'discovered'
  )`);

  const files: Record<string, string> = {
    "/tmp/peon-previews/sess/index.html": "<!doctype html><script>window.inlineRan=true</script><link rel=stylesheet href=styles.css><script src=/assets/app.js></script>",
    "/tmp/peon-previews/sess/styles.css": "body{color:green}",
    "/tmp/peon-previews/sess/assets/app.js": "fetch('./data.json')",
    "/tmp/peon-previews/sess/assets/data.json": "{\"ok\":true}",
  };
  const seen: { file: string; path: string; auth?: string; protocol?: string; actor?: string; range?: string }[] = [];
  const peon = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://peon.invalid");
    const file = url.searchParams.get("path") ?? "";
    seen.push({ file, path: url.pathname, auth: req.headers.authorization, protocol: req.headers["peon-protocol"] as string | undefined, actor: req.headers["peon-actor"] as string | undefined, range: req.headers.range });
    const content = files[file];
    if (content === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: "preview file not found", code: "NOT_FOUND" }));
    }
    if (req.headers.range === "bytes=0-3") {
      res.writeHead(206, { "Content-Type": "wrong/type", "Content-Range": `bytes 0-3/${Buffer.byteLength(content)}`, "Accept-Ranges": "bytes", "Content-Length": "4" });
      return void res.end(content.slice(0, 4));
    }
    res.writeHead(200, { "Content-Type": "wrong/type", "Content-Length": String(Buffer.byteLength(content)) });
    res.end(content);
  });
  const peonPort = await listen(peon);
  await registry.register({
    peonId: "peon-1", credentialId: "cred-1", workspaceId: "ws-1", name: "stub", hostname: null,
    address: "127.0.0.1", controlPort: peonPort, protocol: 1, capabilities: [], token: "pn_super_secret",
    load: null,
  });

  const appServer = http.createServer(createServer());
  const appPort = await listen(appServer);
  const grant = mintWebPreview({ peonId: "peon-1", workspaceId: "ws-1", sessionId: "sess", htmlPath: "/tmp/peon-previews/sess/index.html", actor: "operator@example.com" });
  const host = new URL(grant.url).hostname;

  const html = await rawRequest(appPort, host, "/index.html");
  assert.equal(html.status, 200);
  assert.match(html.body, /window\.inlineRan=true/);
  assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(html.headers["content-security-policy"], "sandbox allow-scripts allow-forms allow-modals allow-downloads");
  assert.equal(html.headers["access-control-allow-origin"], "*");
  assert.equal(html.headers["referrer-policy"], "no-referrer");
  assert.equal(html.headers["x-content-type-options"], "nosniff");
  assert.equal(html.headers["cache-control"], "no-store");

  const css = await rawRequest(appPort, host, "/styles.css");
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  const js = await rawRequest(appPort, host, "/assets/app.js");
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  const json = await rawRequest(appPort, host, "/assets/data.json");
  assert.equal(json.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(seen.slice(0, 4).map((request) => request.file), Object.keys(files));
  assert.ok(seen.every((request) => request.path === "/api/v1/sessions/sess/file/raw"));
  assert.ok(seen.every((request) => request.auth === "Bearer pn_super_secret"));
  assert.ok(seen.every((request) => request.protocol === "1"));
  assert.ok(seen.every((request) => request.actor === "operator@example.com"));
  assert.ok(!html.body.includes("pn_super_secret") && !html.body.includes(String(peonPort)));

  const range = await new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: appPort, path: "/assets/app.js", headers: { Host: host, Range: "bytes=0-3" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(range.status, 206);
  assert.equal(range.body, "fetc");
  assert.match(String(range.headers["content-range"]), /^bytes 0-3\//);

  const beforeTraversal = seen.length;
  const traversal = await rawRequest(appPort, host, "/%2e%2e/secret.txt");
  assert.equal(traversal.status, 403);
  assert.equal(seen.length, beforeTraversal, "rejected traversal must never reach the Peon");

  const missing = await rawRequest(appPort, host, "/missing.html");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /MISSING_PREVIEW/);

  const originalNow = Date.now;
  Date.now = () => grant.expiresAt + 1;
  try {
    const expired = await rawRequest(appPort, host, "/index.html");
    assert.equal(expired.status, 410);
    assert.match(expired.body, /EXPIRED_PREVIEW/);
  } finally {
    Date.now = originalNow;
  }
});
