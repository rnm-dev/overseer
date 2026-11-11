import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-signoff-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-signoff-state-"));

// A fake Claude: each turn logs its start, then holds the turn open until the
// test releases it, so MCP calls happen inside a live turn as they would.
const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-signoff-agent-"));
const log = path.join(fakeDir, "turns.log");
writeFileSync(log, "");
const fakeClaude = path.join(fakeDir, "claude.mjs");
writeFileSync(fakeClaude, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = ${JSON.stringify(log)};
const turn = readFileSync(log, "utf8").split("\\n").filter(Boolean).length + 1;
appendFileSync(log, "start " + turn + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "signoff-test", model: "claude-test" }));
const release = ${JSON.stringify(fakeDir)} + "/release-" + turn;
const timer = setInterval(() => {
  if (!existsSync(release)) return;
  clearInterval(timer);
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "turn " + turn + " done", num_turns: 1 }));
  process.exit(0);
}, 20);
`);
chmodSync(fakeClaude, 0o755);

const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");
const { signoffs, startSignoffs } = await import("../signoffs/index.js");
const { attachSessionRoutes } = await import("../http/fleet/sessions.js");
const { attachSignoffRoutes } = await import("../http/fleet/signoffs.js");
const { createScopedMcpRouter } = await import("../scopedMcp.js");
const { SESSION_MCP_HEADER, sessionMcpCredential } = await import("../sessionMcpAuth.js");
settings.update({ agentCommand: fakeClaude, maxTurns: 1_000, taskTimeoutMs: 60_000 });
startSignoffs();

async function until(predicate: () => boolean, ms = 8_000): Promise<void> {
  for (let waited = 0; waited < ms && !predicate(); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "condition not reached in time");
}

const turns = () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
const release = (turn: number) => writeFileSync(path.join(fakeDir, `release-${turn}`), "");

async function serve() {
  const app = express();
  app.use(express.json());
  app.use("/mcp", createScopedMcpRouter({
    armoryRuntime: {} as never,
    signoffs: { service: signoffs, origin: (id) => sessions.get(id)?.origin ?? (sessions.get(id) ? "operator" : undefined) },
  }));
  const fleet = express.Router();
  fleet.use((req, _res, next) => { req.actor = "owner@example.com"; next(); });
  attachSessionRoutes(fleet, { sessions: sessions as never, getFileTransferRoot: () => undefined, defaultAgent: "claude-code" });
  attachSignoffRoutes(fleet, signoffs);
  app.use("/api/v1", fleet);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, base };
}

async function mcp(base: string, sessionId: string) {
  const client = new Client({ name: "signoff-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/signoffs`), {
    requestInit: { headers: { [SESSION_MCP_HEADER]: sessionMcpCredential(sessionId) } },
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: Boolean(result.isError), text: result.content[0]!.text };
  };
  return { client, call };
}

const proposal = {
  title: "Reply to the supplier",
  summary: "The supplier asks to move the delivery to Friday.",
  options: [{ id: "accept", label: "Accept Friday", actions: [{ id: "reply", summary: "Send the reply", detail: "Friday works for us." }] }],
  context: ["Supplier: can we deliver on Friday instead?"],
};

test("trigger session proposes, settles awaiting sign-off, receives the decision as a follow-up and executes it", async () => {
  const { server, base } = await serve();
  try {
    const created = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Handle the supplier email", dir: fakeDir, agent: "claude-code", origin: "trigger", trigger: { id: "wf-1", source: "email", correlationId: "msg-7" } }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as { id: string; origin: string; trigger: unknown };
    assert.equal(session.origin, "trigger");
    assert.deepEqual(session.trigger, { id: "wf-1", source: "email", correlationId: "msg-7" });
    await until(() => turns() >= 1);

    const agent = await mcp(base, session.id);
    const tools = (await agent.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("signoff_propose"));
    const proposed = await agent.call("signoff_propose", proposal);
    assert.equal(proposed.isError, false, proposed.text);
    const signoffId = (JSON.parse(proposed.text) as { signoff: { id: string } }).signoff.id;

    release(1);
    await until(() => sessions.get(session.id)?.status === "completed");
    assert.equal(sessions.get(session.id)?.settledState, "awaiting_signoff");

    const stale = await fetch(`${base}/api/v1/signoffs/${signoffId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-stale", kind: "approved", baseSeq: 0, optionId: "accept" }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "SIGNOFF_CHANGED");

    const approved = await fetch(`${base}/api/v1/signoffs/${signoffId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "r-1", kind: "approved", baseSeq: 1, optionId: "accept" }),
    });
    assert.equal(approved.status, 201);

    // The approval is delivered into the same session as a follow-up.
    await until(() => turns() >= 2);
    const transcript = sessions.getTranscript(session.id);
    const delivered = transcript.filter((event) => event.type === "user_message").at(-1) as { text?: string; prompt?: string } | undefined;
    assert.match(JSON.stringify(delivered), /Friday works for us/);
    assert.equal(sessions.get(session.id)?.settledState, null);

    assert.equal((await agent.call("signoff_executing", { signoffId, baseSeq: 1 })).isError, false);
    const executed = await agent.call("signoff_executed", { signoffId, baseSeq: 1, results: [{ actionId: "reply", outcome: "done" }] });
    assert.equal(executed.isError, false, executed.text);
    release(2);
    await until(() => sessions.get(session.id)?.status === "completed");

    const view = await (await fetch(`${base}/api/v1/signoffs/${signoffId}`)).json() as { signoff: { status: string; source: unknown }; events: Array<{ kind: string }> };
    assert.equal(view.signoff.status, "done");
    assert.deepEqual(view.signoff.source, { id: "wf-1", source: "email", correlationId: "msg-7" });
    assert.deepEqual(view.events.map((event) => event.kind), ["proposed", "approved", "executing", "executed"]);
    assert.equal(sessions.get(session.id)?.settledState, null);
    await agent.client.close();
  } finally {
    server.close();
  }
});

test("an operator-origin session is not offered signoff_propose and a direct call is refused", async () => {
  const { server, base } = await serve();
  try {
    const record = sessions.start({ prompt: "chat", dir: fakeDir, agent: "claude-code", deferStart: true });
    assert.equal(record.origin, "operator");
    const agent = await mcp(base, record.id);
    const tools = (await agent.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!tools.includes("signoff_propose"));
    assert.ok(tools.includes("signoff_answer"));
    const refused = await agent.call("signoff_propose", proposal);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /ask them directly/);
    await agent.client.close();
  } finally {
    server.close();
  }
});
