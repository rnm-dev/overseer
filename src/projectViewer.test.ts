import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { bindPeon, mintCredential } from "./credentials.js";
import { initDb, query } from "./db.js";
import { issueDevice, WEB_SESSION_COOKIE } from "./modules/auth/index.js";
import { registry } from "./registry.js";
import { replaceMemberAccess } from "./access.js";
import { createServer } from "./server.js";

let server: http.Server;
let port: number;
let ownerCookie: string;
let memberCookie: string;

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('owner','owner@test',1),('member','member@test',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ('viewer-ws','Viewer','viewer','owner',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('viewer-ws','owner','owner',1),('viewer-ws','member','member',1)`);
  const owner = await issueDevice("owner", "test", { ip: null, userAgent: null });
  const member = await issueDevice("member", "test", { ip: null, userAgent: null });
  ownerCookie = `${WEB_SESSION_COOKIE}=${owner.token}`;
  memberCookie = `${WEB_SESSION_COOKIE}=${member.token}`;

  const { credential, token } = await mintCredential("viewer-ws", "Viewer Peon", "owner");
  assert.equal(await bindPeon(credential.id, "viewer-peon"), true);
  await registry.register({
    peonId: "viewer-peon",
    credentialId: credential.id,
    workspaceId: "viewer-ws",
    name: "Viewer Peon",
    hostname: null,
    address: "127.0.0.1",
    controlPort: 4570,
    publicUrl: null,
    protocol: 1,
    capabilities: [],
    token,
    load: null,
  });
  await query(
    `INSERT INTO projects (peon_id,project_id,project_key,name,dir,metadata,synced_at)
     VALUES ('viewer-peon','viewer-project','renamed-key','Viewer','/rnm/viewer',NULL,1)`,
  );

  server = http.createServer(createServer());
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function get(path: string, cookie?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      headers: cookie ? { cookie } : undefined,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          body: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("browser viewer requires a web session and hides inaccessible projects", async () => {
  assert.equal((await get("/view/viewer-peon/viewer-project/docs/index.html")).status, 401);
  const denied = await get("/view/viewer-peon/viewer-project/docs/index.html", memberCookie);
  assert.equal(denied.status, 404);
  assert.equal(denied.body.code, "UNKNOWN_PROJECT");
  assert.equal((await get("/view/viewer-peon/missing/docs/index.html", ownerCookie)).status, 404);
});

test("viewer derives workspace from Peon+project IDs and applies project ACLs", async () => {
  const owner = await get("/view/viewer-peon/viewer-project/docs/index.html", ownerCookie);
  assert.equal(owner.status, 503);
  assert.equal(owner.body.code, "PEON_TRANSFER_UNAVAILABLE");

  await replaceMemberAccess("viewer-ws", "member", {
    peonIds: ["viewer-peon"],
    projects: [{ peonId: "viewer-peon", projectKey: "old-key-is-ignored", projectId: "viewer-project" }],
  }, "owner");
  const member = await get("/view/viewer-peon/viewer-project/docs/index.html", memberCookie);
  assert.equal(member.status, 503);
  assert.equal(member.body.code, "PEON_TRANSFER_UNAVAILABLE");
});
