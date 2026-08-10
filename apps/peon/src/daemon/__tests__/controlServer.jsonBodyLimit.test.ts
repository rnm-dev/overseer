import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { test } from "node:test";
import express from "express";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-test-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-test-state-"));

const { jsonBodyErrorHandler, mcpJsonBodyParser } = await import("../controlServer.js");

const app = express();

// Match controlServer's parser order: the MCP namespace gets its bounded
// larger parser before the default parser sees any other JSON route.
app.use("/mcp", mcpJsonBodyParser());
app.post("/mcp/fixture", (req, res) => {
  res.json({ chars: typeof req.body?.payload === "string" ? req.body.payload.length : null });
});
app.use(express.json());
app.post("/ordinary", (req, res) => {
  res.json({ chars: typeof req.body?.payload === "string" ? req.body.payload.length : null });
});
app.use(jsonBodyErrorHandler);

const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;

test.after(() => server.close());

test("MCP JSON accepts a request larger than Express's default 100 KiB limit", async () => {
  const payload = "x".repeat(150 * 1024);
  const response = await fetch(`http://127.0.0.1:${port}/mcp/fixture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { chars: payload.length });
});

test("ordinary JSON routes retain Express's default 100 KiB limit", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/ordinary`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: "x".repeat(150 * 1024) }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "request body is too large",
    code: "PAYLOAD_TOO_LARGE",
  });
});
