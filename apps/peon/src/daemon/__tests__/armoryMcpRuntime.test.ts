import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ArmoryMcpLifecycleService, ArmoryMcpRuntime } from "../armory/mcpRuntime.js";
import { AtomicJsonStore } from "../armory/atomicJsonStore.js";
import { armoryActivationSchema, type ArmoryManifest } from "../armory/contracts.js";
import { ArmoryOperationError } from "../armory/operationCoordinator.js";
import { packageActivationPath, packageVersionPath } from "../armory/paths.js";
import { ARMORY_COMMAND_PATH } from "../armory/runtimeEnvironment.js";
import { McpBindingRegistry } from "../mcpBindings.js";
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

async function writeActiveMcpPackage(stores: ArmoryStores, source: string): Promise<void> {
  const packageDir = packageVersionPath(stores.paths, "fixture-echo", "1.0.0");
  await mkdir(packageDir, { recursive: true });
  const manifest: ArmoryManifest = {
    schemaVersion: 1,
    id: "fixture-echo",
    version: "1.0.0",
    minPeonVersion: "0.0.1",
    platforms: [{ os: "darwin", arch: "arm64" }],
    permissions: { networkHosts: [], hostPaths: [] },
    dependencies: [],
    configuration: {
      fields: [{ id: "token", label: "Token", type: "secret", required: true }],
      handler: { executable: "node", args: ["configure.mjs"] },
      managedPaths: [],
    },
    mcp: {
      command: { executable: "node", args: ["mcp.mjs"] },
      toolPrefix: "fixture",
      startupTimeoutMs: 1_000,
    },
  };
  await writeFile(path.join(packageDir, "armory.package.json"), JSON.stringify(manifest));
  await writeFile(path.join(packageDir, "mcp.mjs"), source);
  await stores.credentials.set("fixture-echo", { token: "super-secret" });
  const installed = await stores.installed.get("fixture-echo");
  assert.ok(installed);
  const activation = {
    schemaVersion: 1 as const,
    id: "fixture-echo",
    version: "1.0.0",
    previousVersion: null,
    activatedAt: 1,
    sourceDigest: "a".repeat(64),
    operationId: randomUUID(),
    installed,
  };
  await new AtomicJsonStore({
    filePath: packageActivationPath(stores.paths, "fixture-echo"),
    schema: armoryActivationSchema,
    defaults: () => activation,
  }).write(activation);
}

test("MCP startup uses a deterministic PATH and surfaces bounded redacted stderr", async () => {
  const { stores, runtime } = await fixture();
  await writeActiveMcpPackage(stores, `
    process.stderr.write("discarded-prefix-" + "x".repeat(20 * 1024));
    process.stderr.write("\\nPATH=" + process.env.PATH);
    process.stderr.write("\\nINHERITED=" + (process.env.PEON_ARMORY_TEST_INHERITED ?? "missing"));
    process.stderr.write("\\nCAUSE=command not found; TOKEN=super-secret");
    process.exit(127);
  `);
  const previous = process.env.PEON_ARMORY_TEST_INHERITED;
  process.env.PEON_ARMORY_TEST_INHERITED = "operator-only";
  try {
    await assert.rejects(
      runtime.healthCheck("fixture-echo"),
      (error: unknown) => {
        assert.ok(error instanceof ArmoryOperationError);
        assert.equal(error.code, "MCP_START_FAILED");
        assert.match(error.message, /CAUSE=command not found/);
        assert.match(error.message, /TOKEN=\[REDACTED\]/);
        assert.equal(error.message.includes("super-secret"), false);
        assert.equal(error.message.includes("discarded-prefix"), false);
        assert.match(error.message, /INHERITED=missing/);
        assert.ok(error.message.includes(`PATH=${ARMORY_COMMAND_PATH}`));
        assert.ok(Buffer.byteLength(error.message) < 18 * 1024);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PEON_ARMORY_TEST_INHERITED;
    else process.env.PEON_ARMORY_TEST_INHERITED = previous;
    await runtime.close();
  }
});

test("Armory lifecycle health-checks and starts before exposing an enabled package", async () => {
  const { stores, runtime } = await fixture();
  const calls: string[] = [];
  runtime.healthCheck = async (id) => { calls.push(`health:${id}`); };
  runtime.start = async (id) => { calls.push(`start:${id}`); };
  runtime.stop = async (id) => { calls.push(`stop:${id}`); };
  const lifecycle = new ArmoryMcpLifecycleService(runtime);

  const enabling = await lifecycle.enable("fixture-echo");
  const enabledResult = await lifecycle.operations.wait(enabling.id);
  assert.equal(enabledResult.status, "success");
  assert.equal((await stores.installed.get("fixture-echo"))?.enabled, true);
  assert.deepEqual(calls, ["health:fixture-echo", "start:fixture-echo"]);

  const disabling = await lifecycle.disable("fixture-echo");
  const disabledResult = await lifecycle.operations.wait(disabling.id);
  assert.equal(disabledResult.status, "success");
  assert.equal((await stores.installed.get("fixture-echo"))?.enabled, false);
  assert.deepEqual(calls, ["health:fixture-echo", "start:fixture-echo", "stop:fixture-echo"]);
});

test("Armory lifecycle refuses to enable a package that is not ready", async () => {
  const { stores, runtime } = await fixture();
  await stores.installed.update("fixture-echo", (record) => ({ ...record, state: "needs_configuration", configurationStatus: "missing" }));
  const lifecycle = new ArmoryMcpLifecycleService(runtime);
  const operation = await lifecycle.enable("fixture-echo");
  const result = await lifecycle.operations.wait(operation.id);
  assert.equal(result.status, "failure");
  assert.equal(result.errorCode, "PACKAGE_NOT_READY");
  assert.equal((await stores.installed.get("fixture-echo"))?.enabled, false);
});

test("runtime stop hides the package and waits for in-flight tool calls", async () => {
  const { runtime } = await fixture();
  let release!: () => void;
  let closed = false;
  const gate = new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => { release = () => resolve({ content: [{ type: "text", text: "done" }] }); });
  const internal = runtime as unknown as { running: Map<string, unknown> };
  internal.running.set("fixture-echo", {
    client: { callTool: () => gate, close: async () => { closed = true; } },
    transport: { close: async () => undefined },
    manifest: { id: "fixture-echo", mcp: { callTimeoutMs: 1000 } },
    tools: [{ name: "wait" }],
  });
  const call = runtime.callTool("fixture-echo", "wait", {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopping = runtime.stop("fixture-echo");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  assert.equal((await call).content[0]?.type, "text");
  await stopping;
  assert.equal(closed, true);
});

test("reconcile preserves desired enablement and retries transient MCP startup failure", async () => {
  const { stores } = await fixture();
  await stores.installed.update("fixture-echo", (record) => ({ ...record, enabled: true }));
  const runtime = new ArmoryMcpRuntime(stores, new McpBindingRegistry(), { initialDelayMs: 5, maxDelayMs: 10 });
  let starts = 0;
  runtime.start = async (id) => {
    starts += 1;
    if (starts === 1) throw new ArmoryOperationError("MCP_START_FAILED", "temporary startup failure");
    (runtime as unknown as { running: Map<string, unknown> }).running.set(id, {
      client: { close: async () => undefined },
      transport: { close: async () => undefined },
      manifest: { id },
      tools: [],
    });
  };

  await runtime.reconcile();
  const unavailable = await stores.installed.get("fixture-echo");
  assert.equal(unavailable?.enabled, true);
  assert.equal(unavailable?.state, "error");

  const deadline = Date.now() + 1000;
  while ((await stores.installed.get("fixture-echo"))?.state !== "ready" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const recovered = await stores.installed.get("fixture-echo");
  assert.equal(starts, 2);
  assert.equal(recovered?.enabled, true);
  assert.equal(recovered?.state, "ready");
  assert.equal(recovered?.lastError, null);
  await runtime.close();
});

test("disabling an unavailable package cancels its pending startup retry", async () => {
  const { stores } = await fixture();
  await stores.installed.update("fixture-echo", (record) => ({ ...record, enabled: true }));
  const runtime = new ArmoryMcpRuntime(stores, new McpBindingRegistry(), { initialDelayMs: 30, maxDelayMs: 30 });
  let starts = 0;
  runtime.start = async () => {
    starts += 1;
    throw new ArmoryOperationError("MCP_START_FAILED", "temporary startup failure");
  };

  await runtime.reconcile();
  const lifecycle = new ArmoryMcpLifecycleService(runtime);
  const disabling = await lifecycle.disable("fixture-echo");
  assert.equal((await lifecycle.operations.wait(disabling.id)).status, "success");
  const startsAfterDisable = starts;
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(starts, startsAfterDisable);
  assert.equal((await stores.installed.get("fixture-echo"))?.enabled, false);
  await runtime.close();
});

test("a closed runtime cannot be restarted", async () => {
  const { runtime } = await fixture();
  await runtime.close();
  await assert.rejects(
    runtime.start("fixture-echo"),
    (error: unknown) => error instanceof ArmoryOperationError && error.code === "MCP_DRAINING",
  );
});

test("scoped Armory MCP route uses the package id as its path binding", async () => {
  const { runtime } = await fixture();
  runtime.listTools = async (id) => {
    assert.equal(id, "fixture-echo");
    return [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }];
  };
  runtime.callTool = async (id, name, args) => {
    assert.equal(id, "fixture-echo");
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
    const client = new Client({ name: "armory-route-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/armory/fixture-echo`)));
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
