import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { AgentEvent, AgentRun, AgentRunOptions, AgentSteerInput } from "../agents/index.js";
import { getAgentDriver, listAgentDrivers } from "../agents/index.js";
import { CodexAppServerRuntime } from "../agents/runtimes/codexAppServerRuntime.js";
import { createCodexAppServerRun, reconcileCodexAppServerTurn } from "../agents/codexAppServer.js";
import { modelCatalog, narrowNewSessionAgent } from "../modelCatalog.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fakeCodexAppServer.mjs");

function runtime() {
  return new CodexAppServerRuntime({
    command: process.execPath,
    args: [fixture],
    versionArgs: [fixture, "--version"],
    experimentalApi: true,
    requestTimeoutMs: 3_000,
    restartInitialDelayMs: 10,
  });
}

function options(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    agent: "codex-app-server",
    command: process.execPath,
    prompt: "hello",
    cwd: process.cwd(),
    systemPromptAppend: "system",
    sessionId: `session-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

function collect(instance: CodexAppServerRuntime, opts: AgentRunOptions): Promise<{ events: AgentEvent[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    const run = createCodexAppServerRun(opts, instance);
    run.emitter.on("event", (event: AgentEvent) => events.push(event));
    run.emitter.once("exit", (exit) => resolve({ events, code: exit.code }));
    setTimeout(() => reject(new Error("driver run timed out")), 20_000).unref();
  });
}

async function serverRequest(instance: CodexAppServerRuntime, method: string): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve) => {
    const unsubscribe = instance.onNotification((notification) => {
      if (notification.method !== "test/serverResponse") return;
      unsubscribe();
      resolve(notification.params as Record<string, unknown>);
    });
  });
  await instance.request("test/serverRequestNamed", { method, params: { threadId: "thread-1", turnId: "turn-1" } });
  return response;
}

async function waitForRequest(instance: CodexAppServerRuntime, method: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const requests = await instance.request<Array<{ method: string; params: Record<string, unknown> }>>("test/requests");
    const request = requests.findLast((candidate) => candidate.method === method);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${method}`);
}

async function waitForRequestCount(instance: CodexAppServerRuntime, method: string, count: number) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const requests = await instance.request<Array<{ method: string; params: Record<string, unknown> }>>("test/requests");
    if (requests.filter((candidate) => candidate.method === method).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${count} ${method} requests`);
}

async function steer(run: AgentRun, input: AgentSteerInput): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = run.steer?.(input);
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for steerable turn");
}

describe("Codex app-server driver", () => {
  it("registers app-server as the only Codex driver", () => {
    assert.equal(getAgentDriver("codex"), undefined);
    assert.equal(getAgentDriver("codex-app-server")?.legacy, undefined);
    assert.equal(getAgentDriver("codex-app-server")?.label, "Codex");
    assert.equal(getAgentDriver("codex-app-server")?.visible, true);
    assert.ok(listAgentDrivers().some((driver) => driver.id === "codex-app-server"));
    assert.equal(narrowNewSessionAgent("codex-app-server"), "codex-app-server");
    assert.equal(modelCatalog("codex-app-server", null).some((provider) => provider.agent === "codex-app-server"), true);
  });

  it("attributes usage to the resumed or rerouted native model", async () => {
    const instance = runtime();
    try {
      const resumed = await collect(instance, options({ resume: true, backendSessionId: "persisted-thread" }));
      assert.equal(resumed.events.find((event) => event.type === "result")?.model, "fake-model");
      const rerouted = await collect(instance, options({ model: "gpt-5.4", prompt: "hello [REROUTE]" }));
      assert.equal(rerouted.events.find((event) => event.type === "result")?.model, "rerouted-model");
    } finally {
      await instance.stop();
    }
  });

  it("maps turn inputs, sandbox policy, MCP and attachments to native parameters", async () => {
    const instance = runtime();
    const temp = mkdtempSync(path.join(os.tmpdir(), "peon-app-server-driver-"));
    const mcpConfigPath = path.join(temp, "mcp.json");
    writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: { peon: { url: "http://127.0.0.1:4570/mcp/core", headers: { "x-test": "value" } } },
    }));
    try {
      const runOptions = options({
        permissionMode: "plan",
        mcpConfigPath,
        attachments: [{ path: "/tmp/example.png", mimetype: "image/png" }, { path: "/tmp/notes.txt", mimetype: "text/plain" }],
      });
      await collect(instance, runOptions);
      const requests = await instance.request<Array<{ method: string; params: Record<string, unknown> }>>("test/requests");
      const thread = requests.find((request) => request.method === "thread/start")?.params;
      const turn = requests.find((request) => request.method === "turn/start")?.params;
      assert.equal(thread?.approvalPolicy, "never");
      assert.equal(thread?.sandbox, "read-only");
      assert.equal(thread?.developerInstructions, "system");
      assert.deepEqual(thread?.runtimeWorkspaceRoots, [process.cwd()]);
      assert.deepEqual(thread?.config, { mcp_servers: { peon: {
        url: "http://127.0.0.1:4570/mcp/core", env_http_headers: {}, http_headers: { "x-test": "value" },
      } } });
      assert.equal(turn?.approvalPolicy, "never");
      assert.deepEqual(turn?.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(turn?.clientUserMessageId, undefined);
      assert.equal(turn?.responsesapiClientMetadata, undefined);
      assert.deepEqual(turn?.input, [
        { type: "text", text: "hello", text_elements: [] },
        { type: "localImage", path: "/tmp/example.png" },
      ]);
      await collect(instance, options({ resume: true, backendSessionId: "persisted-thread", systemPromptAppend: "updated system" }));
      const updatedRequests = await instance.request<Array<{ method: string; params: Record<string, unknown> }>>("test/requests");
      const resumedThread = updatedRequests.filter((request) => request.method === "thread/resume").at(-1)?.params;
      const defaultTurn = updatedRequests.filter((request) => request.method === "turn/start").at(-1)?.params;
      assert.equal(resumedThread?.developerInstructions, "updated system");
      assert.equal(resumedThread?.sandbox, "danger-full-access");
      assert.deepEqual(defaultTurn?.sandboxPolicy, { type: "dangerFullAccess" });
    } finally {
      await instance.stop();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("answers every unattended request immediately and rejects unsupported request kinds", async () => {
    const instance = runtime();
    try {
      await collect(instance, options());
      assert.deepEqual((await serverRequest(instance, "item/commandExecution/requestApproval")).result, { decision: "decline" });
      assert.deepEqual((await serverRequest(instance, "item/fileChange/requestApproval")).result, { decision: "decline" });
      assert.match(String(((await serverRequest(instance, "item/permissions/requestApproval")).error as Record<string, unknown>).message), /unavailable in unattended Peon sessions/);
      assert.match(String(((await serverRequest(instance, "item/tool/requestUserInput")).error as Record<string, unknown>).message), /unavailable in unattended Peon sessions/);
      assert.deepEqual((await serverRequest(instance, "mcpServer/elicitation/request")).result, { action: "decline", content: null, _meta: null });
      assert.equal(((await serverRequest(instance, "item/tool/call")).result as Record<string, unknown>).success, false);
      assert.deepEqual((await serverRequest(instance, "execCommandApproval")).result, { decision: "denied" });
      assert.match(String(((await serverRequest(instance, "unsupported/request")).error as Record<string, unknown>).message), /No Peon handler registered/);
    } finally {
      await instance.stop();
    }
  });

  it("creates a native thread and normalizes messages, tools, edits, usage and terminal outcome", async () => {
    const instance = runtime();
    let backendState: unknown;
    try {
      const result = await collect(instance, options({ model: "gpt-5.4", onBackendState: (state) => { backendState = state; } }));
      assert.equal(result.code, 0);
      const init = result.events.find((event) => event.type === "system");
      assert.equal(init?.session_id, "thread-1");
      assert.ok(result.events.some((event) => event.type === "assistant" && JSON.stringify(event).includes("reply:thread-1:hello")));
      assert.ok(result.events.some((event) => JSON.stringify(event).includes('"name":"Test"')));
      assert.ok(result.events.some((event) => JSON.stringify(event).includes('"name":"Edit"') && JSON.stringify(event).includes("@@ -1 +1 @@")));
      assert.ok(result.events.some((event) => JSON.stringify(event).includes("peon:status")));
      const terminal = result.events.find((event) => event.type === "result");
      assert.equal(terminal?.is_error, false);
      assert.deepEqual(terminal?.usage, { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3 });
      assert.deepEqual(backendState, { turnId: "turn-1", status: "inProgress", runtimeGeneration: 1 });
    } finally {
      await instance.stop();
    }
  });

  it("reports live model context usage", async () => {
    const instance = runtime();
    try {
      const run = createCodexAppServerRun(options(), instance);
      const context = new Promise<Record<string, number>>((resolve, reject) => {
        run.emitter.once("context", resolve);
        setTimeout(() => reject(new Error("context event timed out")), 10_000).unref();
      });
      const exited = new Promise<void>((resolve) => run.emitter.once("exit", () => resolve()));
      assert.deepEqual(await context, { currentTokens: 18, limitTokens: 1_000 });
      await exited;
    } finally {
      await instance.stop();
    }
  });

  it("accepts command output above 4 MiB, truncates it, and keeps the runtime usable", async () => {
    const instance = runtime();
    const root = mkdtempSync(path.join(os.tmpdir(), "peon-large-output-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = root;
    try {
      const result = await collect(instance, options({ sessionId: "large-output-session", prompt: "[LARGE_OUTPUT]" }));
      assert.equal(result.code, 0);
      const warning = result.events.find((event) => event.type === "warning");
      assert.equal(warning?.code, "payload_truncated");
      assert.ok(typeof warning?.logPath === "string");
      assert.ok(Buffer.byteLength(readFileSync(warning!.logPath as string, "utf8")) > 4 * 1024 * 1024);
      const toolResult = result.events.find((event) => event.type === "user" && JSON.stringify(event).includes("tool_result"));
      assert.ok(Buffer.byteLength(JSON.stringify(toolResult)) < 4 * 1024 * 1024);
      assert.equal((await collect(instance, options({ prompt: "still usable" }))).code, 0);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      await instance.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes the same backend thread and preserves structured outcomes", async () => {
    const instance = runtime();
    try {
      const result = await collect(instance, options({
        resume: true,
        backendSessionId: "persisted-thread",
        outcomeSchema: { type: "object" },
      }));
      assert.equal(result.events.some((event) => event.type === "system"), false);
      const terminal = result.events.find((event) => event.type === "result");
      assert.equal(terminal?.is_error, false);
      assert.deepEqual(terminal?.structured_output, { result: "success", summary: "reply:persisted-thread" });
    } finally {
      await instance.stop();
    }
  });

  it("isolates concurrent sessions and reports native turn failures", async () => {
    const instance = runtime();
    try {
      const [slow, fast, failed] = await Promise.all([
        collect(instance, options({ prompt: "slow [SLOW]" })),
        collect(instance, options({ prompt: "fast" })),
        collect(instance, options({ prompt: "broken [FAIL]" })),
      ]);
      assert.ok(JSON.stringify(slow.events).includes("reply:thread-1:slow [SLOW]"));
      assert.ok(JSON.stringify(fast.events).includes("reply:thread-2:fast"));
      assert.equal(JSON.stringify(slow.events).includes("reply:thread-2"), false);
      const failedResult = failed.events.find((event) => event.type === "result");
      assert.equal(failedResult?.is_error, true);
      assert.match(JSON.stringify(failedResult), /fake turn failure/);
    } finally {
      await instance.stop();
    }
  });

  it("serializes turns that resume the same native thread", async () => {
    const instance = runtime();
    const completionOrder: string[] = [];
    try {
      const slow = collect(instance, options({ resume: true, backendSessionId: "shared-thread", prompt: "first [SLOW]" }))
        .then((result) => { completionOrder.push("first"); return result; });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const fast = collect(instance, options({ resume: true, backendSessionId: "shared-thread", prompt: "second" }))
        .then((result) => { completionOrder.push("second"); return result; });
      const [first, second] = await Promise.all([slow, fast]);
      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      assert.deepEqual(completionOrder, ["first", "second"]);
      assert.ok(JSON.stringify(second.events).includes("reply:shared-thread:second"));
    } finally {
      await instance.stop();
    }
  });

  it("steers the active native turn with its exact id and maps supported attachments", async () => {
    const instance = runtime();
    const events: AgentEvent[] = [];
    try {
      const run = createCodexAppServerRun(options({ prompt: "first [SLOW]" }), instance);
      const started = new Promise<void>((resolve) => run.emitter.on("event", (event: AgentEvent) => {
        events.push(event);
        if (event.type === "system") resolve();
      }));
      const exited = new Promise<void>((resolve) => run.emitter.once("exit", () => resolve()));

      await started;
      await waitForRequest(instance, "turn/start");
      assert.equal(run.steer?.({ prompt: "not compatible", attachments: [], permissionMode: "plan" }), undefined);
      await steer(run, {
        prompt: "steered",
        attachments: [{ path: "/tmp/steered.png", mimetype: "image/png" }],
      });
      await exited;

      const requests = await instance.request<Array<{ method: string; params: Record<string, unknown> }>>("test/requests");
      const nativeSteer = requests.find((request) => request.method === "turn/steer")?.params;
      assert.equal(nativeSteer?.threadId, "thread-1");
      assert.equal(nativeSteer?.expectedTurnId, "turn-1");
      assert.deepEqual(nativeSteer?.input, [
        { type: "text", text: "steered", text_elements: [] },
        { type: "localImage", path: "/tmp/steered.png" },
      ]);
      assert.equal(requests.filter((request) => request.method === "turn/steer").length, 1);
      assert.ok(JSON.stringify(events).includes("reply:thread-1:steered"));
    } finally {
      await instance.stop();
    }
  });

  it("surfaces native steer rejection and interrupts the exact active turn", async () => {
    const instance = runtime();
    try {
      const run = createCodexAppServerRun(options({ prompt: "first [SLOW]" }), instance);
      const started = new Promise<void>((resolve) => run.emitter.on("event", (event: AgentEvent) => {
        if (event.type === "system") resolve();
      }));
      const exited = new Promise<{ signal: NodeJS.Signals | null }>((resolve) => run.emitter.once("exit", resolve));
      await started;
      await waitForRequest(instance, "turn/start");
      await assert.rejects(steer(run, { prompt: "[STEER_FAIL]", attachments: [] }), /fake steer failure/);
      run.kill();
      assert.equal((await exited).signal, "SIGTERM");
      const interrupt = await waitForRequest(instance, "turn/interrupt");
      assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
    } finally {
      await instance.stop();
    }
  });

  it("reconciles persisted native turns without replaying completed work", async () => {
    const instance = runtime();
    try {
      assert.deepEqual(await reconcileCodexAppServerTurn({
        command: process.execPath, backendSessionId: null, backendTurnId: null, runtimeGeneration: null,
      }, instance), {
        status: "unknown", backendTurnId: null, runtimeGeneration: null, detail: "missing Codex thread id",
      });
      await collect(instance, options({ prompt: "completed" }));
      assert.deepEqual(await reconcileCodexAppServerTurn({
        command: process.execPath, backendSessionId: "thread-1", backendTurnId: "turn-1", runtimeGeneration: 1,
      }, instance), {
        status: "completed", backendTurnId: "turn-1", runtimeGeneration: 1,
      });

      const active = createCodexAppServerRun(options({ prompt: "active [SLOW]" }), instance);
      const exited = new Promise<void>((resolve) => active.emitter.once("exit", () => resolve()));
      await waitForRequestCount(instance, "turn/start", 2);
      assert.deepEqual(await reconcileCodexAppServerTurn({
        command: process.execPath, backendSessionId: "thread-2", backendTurnId: "turn-2", runtimeGeneration: 1,
      }, instance), {
        status: "interrupted", backendTurnId: "turn-2", runtimeGeneration: 1,
      });
      await exited;
      const requests = await instance.request<Array<{ method: string; params: Record<string, unknown> }>>("test/requests");
      assert.ok(requests.some((request) => request.method === "thread/read" && request.params.threadId === "thread-1"));
      assert.ok(requests.some((request) => request.method === "turn/interrupt" && request.params.turnId === "turn-2"));
    } finally {
      await instance.stop();
    }
  });
});
