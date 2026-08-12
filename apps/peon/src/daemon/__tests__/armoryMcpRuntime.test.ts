import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ArmoryMcpRuntime } from "../armory/mcpRuntime.js";
import { createArmoryStores, initializeArmoryDirectories, type ArmoryStores } from "../armory/stores.js";
import { createScopedMcpRouter } from "../scopedMcp.js";
import { ProjectService } from "../projects/service.js";
import { ProjectStore } from "../projects/contracts.js";
import { SESSION_MCP_HEADER, sessionMcpCredential } from "../sessionMcpAuth.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-armory-mcp-runtime-"));
  const stores = createArmoryStores({
    data: path.join(root, "data"),
    state: path.join(root, "state"),
    config: path.join(root, "config"),
  });
  await initializeArmoryDirectories(stores.paths);
  await stores.installed.set({
    id: "fixture-echo",
    version: "1.0.0",
    enabled: false,
    state: "ready",
    installedAt: 1,
    updatedAt: 1,
    sourceDigest: "a".repeat(64),
    configurationStatus: "not_required",
    lastError: null,
    activeOperationId: null,
    capabilities: { mcp: true },
  });
  return { stores, runtime: new ArmoryMcpRuntime(stores) };
}

test("scoped Armory MCP route requires a session-bound turn capability", async () => {
  const { runtime } = await fixture();
  runtime.listTools = async (id, sessionId) => {
    assert.equal(id, "turn-binding");
    assert.equal(sessionId, "bound-session");
    return [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
  };
  runtime.callTool = async (id, sessionId, name, args) => {
    assert.equal(id, "turn-binding");
    assert.equal(sessionId, "bound-session");
    assert.equal(name, "echo");
    return { content: [{ type: "text", text: String(args.text) }] };
  };

  const app = express();
  app.use(express.json());
  app.use("/mcp", createScopedMcpRouter({ armoryRuntime: runtime }));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp/armory/turn-binding`);
    const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
    const client = new Client({ name: "armory-route-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { [SESSION_MCP_HEADER]: sessionMcpCredential("bound-session") } },
    }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : null, "hello");
    await client.close();
  } finally {
    server.close();
  }
});
test("scoped project MCP route provides quick-link CRUD", async () => {
  const { runtime } = await fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "peon-project-mcp-"));
  const projectService = new ProjectService(new ProjectStore(path.join(root, "projects.json")), {
    list: () => [],
    renameProjectKey: () => 0,
    start: () => ({ id: "onboarding" }),
    rename: () => undefined,
  });
  const project = projectService.create({ label: "MCP Links", dir: path.join(root, "project") });
  const app = express();
  app.use(express.json());
  app.use("/mcp", createScopedMcpRouter({ armoryRuntime: runtime, projectService }));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const client = new Client({ name: "project-route-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/projects`)));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), [
      "list_project_quick_links",
      "create_project_quick_link",
      "update_project_quick_link",
      "delete_project_quick_link",
    ]);
    const created = await client.callTool({
      name: "create_project_quick_link",
      arguments: { projectKey: project.key, title: "Docs", url: "https://example.com/docs" },
    });
    const createdLink = JSON.parse(created.content[0]?.type === "text" ? created.content[0].text : "{}") as { id: string };
    await client.callTool({
      name: "update_project_quick_link",
      arguments: { projectKey: project.key, id: createdLink.id, title: "Documentation" },
    });
    const listed = await client.callTool({ name: "list_project_quick_links", arguments: { projectKey: project.key } });
    assert.equal(listed.content[0]?.type === "text" ? JSON.parse(listed.content[0].text).links[0].title : null, "Documentation");
    await client.callTool({ name: "delete_project_quick_link", arguments: { projectKey: project.key, id: createdLink.id } });
    assert.deepEqual(projectService.listQuickLinks(project.key), { links: [] });
    await client.close();
  } finally {
    server.close();
  }
});

test("session MCP route requires a bound capability and exposes orchestration tools", async () => {
  const { runtime } = await fixture();
  const calls: Array<{ parent: string; input: unknown }> = [];
  const transcriptCalls: Array<{ parent: string; input: unknown }> = [];
  const followUpCalls: Array<{ parent: string; input: unknown }> = [];
  const sessionOrchestration = {
    listOptions: (parent: string) => ({
      defaultAgent: "codex-app-server" as const,
      projects: [],
      providers: [],
      limits: { maxSpawnDepth: 1 },
      parent,
    }),
    spawn: (parent: string, input: unknown) => {
      calls.push({ parent, input });
      return { children: [], replayed: [] };
    },
    children: () => ({ children: [] }),
    wait: async () => ({ completed: true, timedOut: false, children: [] }),
    transcript: async (parent: string, input: unknown) => {
      transcriptCalls.push({ parent, input });
      return { sessionId: "child", events: [], nextCursor: null, hasMore: false, responseTruncated: false };
    },
    followUp: (parent: string, input: unknown) => {
      followUpCalls.push({ parent, input });
      return { session: { id: "target" } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/mcp", createScopedMcpRouter({ armoryRuntime: runtime, sessionOrchestration }));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp/sessions`);
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const client = new Client({ name: "session-route-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { [SESSION_MCP_HEADER]: sessionMcpCredential("parent-session") } },
    }));
    const sessionTools = (await client.listTools()).tools;
    assert.deepEqual(sessionTools.map((tool) => tool.name), [
      "list_session_options",
      "spawn_sessions",
      "get_child_sessions",
      "wait_for_child_sessions",
      "get_child_transcript",
      "send_session_followup",
    ]);
    assert.match(
      sessionTools.find((tool) => tool.name === "spawn_sessions")?.description ?? "",
      /every later turn initiated with send_session_followup each enqueue one hidden completion trigger/,
    );
    assert.match(
      sessionTools.find((tool) => tool.name === "spawn_sessions")?.description ?? "",
      /whenever the user asks to create, start, or delegate work to another session/,
    );
    assert.match(
      sessionTools.find((tool) => tool.name === "spawn_sessions")?.description ?? "",
      /do not substitute provider-native sub-agents/,
    );
    assert.match(
      sessionTools.find((tool) => tool.name === "send_session_followup")?.description ?? "",
      /completion enqueues a new hidden trigger for the caller/,
    );
    await client.callTool({
      name: "spawn_sessions",
      arguments: { sessions: [{ requestId: "one", name: "Named child", prompt: "work", projectKey: "peon", agent: "codex-app-server" }] },
    });
    assert.deepEqual(calls, [{
      parent: "parent-session",
      input: { sessions: [{ requestId: "one", name: "Named child", prompt: "work", projectKey: "peon", agent: "codex-app-server" }] },
    }]);
    await client.callTool({
      name: "get_child_transcript",
      arguments: { sessionId: "child", limit: 5 },
    });
    assert.deepEqual(transcriptCalls, [{
      parent: "parent-session",
      input: { sessionId: "child", limit: 5 },
    }]);
    await client.callTool({
      name: "send_session_followup",
      arguments: { sessionId: "target", prompt: "continue" },
    });
    assert.deepEqual(followUpCalls, [{
      parent: "parent-session",
      input: { sessionId: "target", prompt: "continue" },
    }]);
    await client.close();
  } finally {
    server.close();
  }
});

test("managed plugin MCP is session-scoped and returns the operator decision to the same tool call", async () => {
  const { runtime } = await fixture();
  const calls: Array<{ sessionId: string; pluginId: string }> = [];
  const app = express();
  app.use(express.json());
  app.use("/mcp", createScopedMcpRouter({
    armoryRuntime: runtime,
    requestManagedPluginInstall: async (sessionId, pluginId) => {
      calls.push({ sessionId, pluginId });
      return { contentItems: [{ type: "inputText", text: "The operator installed the managed plugin." }], success: true };
    },
  }));
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp/plugins`);
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const client = new Client({ name: "plugin-route-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { [SESSION_MCP_HEADER]: sessionMcpCredential("parent-session") } },
    }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["request_plugin_install"]);
    const result = await client.callTool({
      name: "request_plugin_install",
      arguments: { plugin_id: "posthog@openai-curated-remote" },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls, [{ sessionId: "parent-session", pluginId: "posthog@openai-curated-remote" }]);
    await client.close();
  } finally {
    server.close();
  }
});
