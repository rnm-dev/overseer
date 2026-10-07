import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { issueDevice } from "../../modules/auth/index.js";
import { registry } from "../../modules/fleet/index.js";
import { replaceMemberAccess } from "../../modules/access/index.js";
import { createServer } from "../../app/server.js";

test("provider login proxies require workspace ownership for reads, code submission, cancellation and logout", async () => {
  const Pool = newDb().adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  await query("INSERT INTO users (id,email,created_at) VALUES ('owner','owner@test.dev',1),('member','member@test.dev',1)");
  await query("INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ('login-ws','Login','login','owner',1)");
  await query("INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('login-ws','owner','owner',1),('login-ws','member','member',1)");
  const owner = await issueDevice("owner", "test", { ip: null, userAgent: null });
  const member = await issueDevice("member", "test", { ip: null, userAgent: null });
  const seen: Array<{ path: string; actor: unknown; body: string }> = [];
  const peon = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ path: req.url!, actor: req.headers["peon-actor"], body });
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"status":"starting"}');
    });
  });
  const app = http.createServer(createServer());
  try {
    await new Promise<void>((resolve) => peon.listen(0, "127.0.0.1", resolve));
    await registry.register({ peonId: "login-peon", credentialId: "login-cred", workspaceId: "login-ws", name: "Login", hostname: null,
      address: "127.0.0.1", controlPort: (peon.address() as AddressInfo).port, protocol: 1, capabilities: [], token: "peon-token", load: null });
    await replaceMemberAccess("login-ws", "member", { peonIds: ["login-peon"], projects: [] }, "owner");
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/workspaces/login-ws/peons/login-peon/driver`;
    for (const [method, route] of [["POST", "claude-code/logout"], ["POST", "codex/logout"], ["GET", "claude-code/login"], ["POST", "claude-code/login"], ["POST", "claude-code/login/attempt/code"], ["DELETE", "claude-code/login/attempt"], ["GET", "codex/login/attempt"], ["POST", "codex/login"], ["DELETE", "codex/login/attempt"]]) {
      const denied = await fetch(`${base}/${route}`, { method, headers: { Authorization: `Bearer ${member.token}` } });
      assert.equal(denied.status, 403);
      const before = seen.length;
      const response = await fetch(`${base}/${route}`, { method, headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: route.endsWith("/logout") ? "{}" : '{"code":"private-code"}' } : {}) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(seen.length, before + 1);
      assert.equal(seen.at(-1)!.path, `/api/v1/driver/${route}`);
      assert.equal(seen.at(-1)!.actor, "owner@test.dev");
    }
    assert.equal(seen.length, 9);
  } finally {
    await Promise.all([app, peon].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});
