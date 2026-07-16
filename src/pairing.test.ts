import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { issueDevice } from "./auth.js";
import { config } from "./config.js";
import { initDb, query } from "./db.js";
import { createServer } from "./server.js";
import { createWorkspace } from "./workspaces.js";

const servers: http.Server[] = [];
after(async () => Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function setup(): Promise<{ appPort: number; token: string; workspaceId: string }> {
  const db = newDb();
  const Pool = db.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id, email, created_at) VALUES ('owner', 'owner@example.test', $1)`, [Date.now()]);
  const workspace = await createWorkspace("Pairing", "owner");
  const device = await issueDevice("owner", "test", { ip: null, userAgent: null });
  config.peonCallbackUrl = "http://overseer.example:4580";
  return { appPort: await listen(http.createServer(createServer())), token: device.token, workspaceId: workspace.id };
}

function postJson(port: number, path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path, method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(encoded) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

test("invalid phrase preserves the Peon 401 message and correlation ID", async () => {
  const peonPort = await listen(http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json", "peon-request-id": "pair-401" });
    res.end(JSON.stringify({ code: "UNAUTHENTICATED", error: "pairing phrase is expired or already used — arm a new phrase on the peon and retry" }));
  }));
  const app = await setup();
  const result = await postJson(app.appPort, `/api/workspaces/${app.workspaceId}/peons/recruit`, app.token, {
    address: `http://127.0.0.1:${peonPort}`, secret: "expired phrase",
  });
  assert.equal(result.status, 401);
  assert.equal(result.json.code, "UNAUTHENTICATED");
  assert.match(String(result.json.error), /arm a new phrase/);
  assert.equal(result.json.requestId, "pair-401");
  const { rows } = await query<{ revoked_at: number | null }>(`SELECT revoked_at FROM peon_credentials`);
  assert.ok(rows[0].revoked_at);
});

test("invalid configuration preserves the 400 message and the same phrase can retry", async () => {
  let attempts = 0;
  const seenTokens: string[] = [];
  const peonPort = await listen(http.createServer((req, res) => {
    seenTokens.push(req.headers.authorization ?? "");
    attempts += 1;
    res.setHeader("content-type", "application/json");
    if (attempts === 1) {
      res.writeHead(400);
      res.end(JSON.stringify({ code: "BAD_REQUEST", error: "overseer callback URL is not allowed" }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, peonId: "stable-uuid", publicUrl: `http://127.0.0.1:${peonPort}` }));
    }
  }));
  const app = await setup();
  const request = { address: `http://127.0.0.1:${peonPort}`, secret: "reusable phrase" };
  const first = await postJson(app.appPort, `/api/workspaces/${app.workspaceId}/peons/recruit`, app.token, request);
  const second = await postJson(app.appPort, `/api/workspaces/${app.workspaceId}/peons/recruit`, app.token, request);
  assert.equal(first.status, 400);
  assert.deepEqual({ code: first.json.code, error: first.json.error }, { code: "BAD_REQUEST", error: "overseer callback URL is not allowed" });
  assert.equal(second.status, 201);
  assert.equal(second.json.state, "paired_waiting_registration");
  assert.equal(seenTokens.length, 2);
  assert.ok(seenTokens.every((value) => value === "Bearer reusable phrase"));
});
