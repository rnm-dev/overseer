import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";

const cli = path.resolve("src/cli/peon.ts");

async function runCli(args: string[], controlUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, ACA_CONTROL_URL: controlUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("enroll and pair arm the same one-time phrase flow", async () => {
  let arms = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/v1/settings") {
      res.end(JSON.stringify({ publicControlUrl: "http://nova.mesh.rnm:4570", listenAddress: "0.0.0.0:4570" }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/pairing/arm") {
      arms += 1;
      res.end(JSON.stringify({ ok: true, phrase: "lok-tar-ogar-dabu", expiresAt: Date.now() + 15 * 60_000 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const command of ["enroll", "pair"]) {
      const result = await runCli([command], controlUrl);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /address\s+: http:\/\/nova\.mesh\.rnm:4570/);
      assert.match(result.stdout, /phrase\s+: lok-tar-ogar-dabu/);
      assert.match(result.stdout, /single-use/);
      assert.doesNotMatch(result.stdout, /claim|operator code|legacy/i);
    }
    assert.equal(arms, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("pair prefers a concrete remote listener over a stale loopback public URL", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/v1/settings") {
      res.end(JSON.stringify({
        publicControlUrl: "http://127.0.0.1:4570",
        listenAddress: "194.238.43.159:4570",
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/pairing/arm") {
      res.end(JSON.stringify({ ok: true, phrase: "axe-dark-zaela-hellscream", expiresAt: Date.now() + 15 * 60_000 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controlUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await runCli(["pair"], controlUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /address\s+: http:\/\/194\.238\.43\.159:4570/);
    assert.doesNotMatch(result.stdout, /address\s+: http:\/\/127\.0\.0\.1:4570/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
