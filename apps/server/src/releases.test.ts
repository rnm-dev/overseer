import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "./config.js";
import { initDb, query } from "./db.js";
import { createServer } from "./server.js";

let server: http.Server;
let port: number;
let releaseDirectory: string;
const publisherToken = "test-release-publisher";
const peonToken = "pn_release_test";
const originalConfig = {
  releaseToken: config.releaseToken,
  releaseDirectory: config.releaseDirectory,
  releaseMaxBytes: config.releaseMaxBytes,
};

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(
    `INSERT INTO peon_credentials (id,workspace_id,token,label,created_by,created_at,revoked_at,bound_peon_id)
     VALUES ('release-cred','ws-release',$1,'release test','test',1,NULL,NULL)`,
    [peonToken],
  );
  releaseDirectory = await mkdtemp(path.join(os.tmpdir(), "overseer-releases-"));
  config.releaseToken = publisherToken;
  config.releaseDirectory = releaseDirectory;
  config.releaseMaxBytes = 1024;
  server = http.createServer(createServer());
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  Object.assign(config, originalConfig);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(releaseDirectory, { recursive: true, force: true });
});

interface ResponseValue {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(url: string, options: { method?: string; token?: string; body?: Buffer; checksum?: string; range?: string } = {}): Promise<ResponseValue> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = options.body.length;
    }
    if (options.checksum) headers["Peon-Content-Sha256"] = options.checksum;
    if (options.range) headers.Range = options.range;
    const req = http.request({ hostname: "127.0.0.1", port, path: url, method: options.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const json = (response: ResponseValue): Record<string, unknown> => JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;

test("publishes a global release and serves latest metadata and archive ranges to Peons", async () => {
  const archive = Buffer.from("release archive bytes");
  const sha256 = createHash("sha256").update(archive).digest("hex");

  const unauthenticated = await request("/api/releases/1.2.3", { method: "PUT", body: archive });
  assert.equal(unauthenticated.status, 401);

  const published = await request("/api/releases/1.2.3", { method: "PUT", token: publisherToken, body: archive, checksum: sha256 });
  assert.equal(published.status, 201);
  assert.deepEqual(json(published).release, {
    version: "1.2.3",
    revision: sha256,
    size: archive.length,
    sha256,
    createdAt: (json(published).release as { createdAt: number }).createdAt,
    archiveUrl: "/api/v1/releases/1.2.3/archive",
  });

  assert.equal((await request("/api/v1/releases/latest")).status, 401);
  const latest = await request("/api/v1/releases/latest", { token: peonToken });
  assert.equal(latest.status, 200);
  assert.equal((json(latest).release as { version: string }).version, "1.2.3");

  const full = await request("/api/v1/releases/1.2.3/archive", { token: peonToken });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, archive);
  assert.equal(full.headers["peon-content-sha256"], sha256);
  assert.equal(full.headers.etag, `"${sha256}"`);

  const partial = await request("/api/v1/releases/1.2.3/archive", { token: peonToken, range: "bytes=8-14" });
  assert.equal(partial.status, 206);
  assert.equal(partial.body.toString(), "archive");
  assert.equal(partial.headers["content-range"], `bytes 8-14/${archive.length}`);
});

test("rejects duplicate versions, checksum mismatches, invalid versions, and oversized archives", async () => {
  const archive = Buffer.from("different bytes");
  assert.equal((await request("/api/releases/1.2.3", { method: "PUT", token: publisherToken, body: archive })).status, 409);

  const mismatch = await request("/api/releases/1.2.4", {
    method: "PUT", token: publisherToken, body: archive, checksum: "0".repeat(64),
  });
  assert.equal(mismatch.status, 409);
  assert.equal(json(mismatch).code, "CHECKSUM_MISMATCH");

  assert.equal((await request("/api/releases/not%20valid", { method: "PUT", token: publisherToken, body: archive })).status, 400);
  assert.equal((await request("/api/releases/2.0.0", { method: "PUT", token: publisherToken, body: Buffer.alloc(1025) })).status, 413);

  const tempFiles = await readdir(path.join(releaseDirectory, "tmp"));
  assert.deepEqual(tempFiles, []);
});
