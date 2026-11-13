import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temp = mkdtempSync(path.join(os.tmpdir(), "peon-opencode-"));
process.env.XDG_CONFIG_HOME = path.join(temp, "config");
process.env.XDG_STATE_HOME = path.join(temp, "state");
process.env.XDG_DATA_HOME = path.join(temp, "data");
const {
  canonicalTool, normalizeOpencodeProviders, OpencodeUsage, outcomeInstructions, parseOutcomeText, runOpencode,
} = await import("../agents/opencode.js");
const { getAgentDriver, agentServiceName } = await import("../agents/index.js");
const { canonicalUsageProvider, normalizeTokenUsage } = await import("../sessions/index.js");
type OpencodeServer = import("../agents/opencodeServer.js").OpencodeServer;
type AgentEvent = import("../agents/index.js").AgentEvent;
test.after(() => rmSync(temp, { recursive: true, force: true }));

// A scripted stand-in for `opencode serve`: records requests and lets the test
// push SSE events.
function fakeServer(script: (call: { method: string; path: string; body: unknown }, push: (event: Record<string, unknown>) => void) => unknown) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const queue: Array<Record<string, unknown>> = [];
  let wake: (() => void) | null = null;
  let stopped = false;
  const push = (event: Record<string, unknown>) => { queue.push(event); wake?.(); };
  const server: OpencodeServer = {
    baseUrl: "http://fake",
    async request<T>(method: string, pathname: string, options: { body?: unknown } = {}) {
      const call = { method, path: pathname, body: options.body };
      calls.push(call);
      return script(call, push) as T;
    },
    async *events(signal: AbortSignal) {
      while (!signal.aborted && !stopped) {
        if (!queue.length) await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
        while (queue.length) yield queue.shift()!;
      }
    },
    onExit() {},
    async stop() { stopped = true; wake?.(); },
  };
  return { server, calls, push };
}

function collect(run: { emitter: import("node:events").EventEmitter }) {
  const events: AgentEvent[] = [];
  const contexts: unknown[] = [];
  run.emitter.on("event", (event: AgentEvent) => events.push(event));
  run.emitter.on("context", (value: unknown) => contexts.push(value));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => run.emitter.once("exit", resolve));
  return { events, contexts, exited };
}

const SID = "ses_test";
const turnEvents = (push: (event: Record<string, unknown>) => void, finalText: string) => {
  const p = (type: string, properties: Record<string, unknown>) => push({ type, properties: { sessionID: SID, ...properties } });
  p("session.status", { status: { type: "busy" } });
  p("message.part.updated", { part: { id: "prt_tool", type: "tool", tool: "edit", callID: "call_1", state: { status: "running", input: {} } } });
  p("message.part.updated", { part: { id: "prt_tool", type: "tool", tool: "edit", callID: "call_1", state: { status: "completed", input: { filePath: "/w/a.ts", oldString: "a", newString: "b" }, output: "Edit applied" } } });
  p("message.part.updated", { part: { id: "prt_bash", type: "tool", tool: "bash", callID: "call_2", state: { status: "error", input: { command: "false" }, error: "exit 1" } } });
  p("message.part.updated", { part: { id: "prt_text", type: "text", text: finalText, time: { start: 1 } } });
  p("message.part.updated", { part: { id: "prt_text", type: "text", text: finalText, time: { start: 1, end: 2 } } });
  p("session.idle", {});
  // Final accounting trails the idle signal, as opencode does.
  p("message.updated", { info: { id: "msg_1", role: "assistant", modelID: "openai/gpt-5", cost: 0.25, time: { created: 1, completed: 2 }, tokens: { total: 1150, input: 600, output: 100, reasoning: 50, cache: { read: 400, write: 0 } } } });
};

test("a new turn creates a session, prompts once and normalizes tools, text, usage and cost", async () => {
  const { server, calls } = fakeServer((call, push) => {
    if (call.method === "POST" && call.path === "/session") return { id: SID };
    if (call.path.endsWith("/prompt_async")) { setImmediate(() => turnEvents(push, "Done.")); return null; }
    return null;
  });
  const run = runOpencode({
    agent: "opencode", command: "opencode", prompt: "do it", cwd: "/w", systemPromptAppend: "PEON", sessionId: "peon-1",
    model: "openai/gpt-5", reasoningEffort: "high", attachments: [{ path: "/w/shot.png", mimetype: "image/png", name: "shot.png" }],
  }, async () => server);
  const { events, exited } = collect(run);
  assert.deepEqual(await exited, { code: 0, signal: null, spawnError: null });

  const prompt = calls.find((call) => call.path.endsWith("/prompt_async"))!;
  assert.equal(prompt.path, `/session/${SID}/prompt_async`);
  const body = prompt.body as Record<string, unknown>;
  assert.deepEqual(body.model, { providerID: "openrouter", modelID: "openai/gpt-5" });
  assert.equal(body.variant, "high");
  assert.equal(body.system, "PEON");
  assert.deepEqual((body.parts as unknown[])[1], { type: "file", mime: "image/png", url: "file:///w/shot.png", filename: "shot.png" });
  assert.deepEqual((calls.find((call) => call.path === "/session")!.body as Record<string, unknown>).permission, [{ permission: "*", pattern: "*", action: "allow" }]);

  assert.deepEqual(events[0], { type: "system", subtype: "init", session_id: SID, model: "openai/gpt-5" });
  const toolUses = events.flatMap((event) => (event.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? []).filter((block) => block.type === "tool_use");
  assert.deepEqual(toolUses.map((block) => [block.name, block.input]), [
    ["Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" }],
    ["Bash", { command: "false" }],
  ]);
  const failedResult = events.flatMap((event) => (event.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? []).find((block) => block.tool_use_id === "call_2");
  assert.equal(failedResult?.is_error, true);
  assert.equal(events.filter((event) => event.type === "assistant" && JSON.stringify(event).includes("Done.")).length, 1, "text is emitted once, when complete");

  const result = events.at(-1)!;
  assert.equal(result.type, "result");
  assert.equal(result.is_error, false);
  assert.equal(result.result, "Done.");
  assert.equal(result.total_cost_usd, 0.25);
  assert.equal(result.model, "openai/gpt-5");
  assert.deepEqual(result.usage, { input_tokens: 600, output_tokens: 150, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, reasoning_output_tokens: 50 });
});

test("a resumed turn reuses the session and parses the outcome from the final text", async () => {
  const { server, calls } = fakeServer((call, push) => {
    if (call.path.endsWith("/prompt_async")) { setImmediate(() => turnEvents(push, "```json\n{\"result\":\"success\",\"summary\":\"ok\",\"previewPath\":null}\n```")); return null; }
    return { id: SID };
  });
  const schema = { type: "object" };
  const run = runOpencode({
    agent: "opencode", command: "opencode", prompt: "again", cwd: "/w", systemPromptAppend: "", sessionId: "peon-1",
    model: "openai/gpt-5", resume: true, backendSessionId: SID, outcomeSchema: schema,
  }, async () => server);
  const { events, exited } = collect(run);
  assert.equal((await exited).code, 0);
  assert.equal(calls.some((call) => call.method === "POST" && call.path === "/session"), false);
  assert.ok(calls.some((call) => call.method === "GET" && call.path === `/session/${SID}`));
  assert.equal((calls.find((call) => call.path.endsWith("/prompt_async"))!.body as { system: string }).system, outcomeInstructions(schema));
  assert.equal(events.some((event) => event.type === "init" || (event.type === "system" && event.subtype === "init")), false);
  assert.equal(events.some((event) => event.type === "assistant" && JSON.stringify(event).includes("summary")), false, "outcome JSON is not rendered as chat");
  assert.deepEqual(events.at(-1)!.structured_output, { result: "success", summary: "ok", previewPath: null });
});

test("provider errors fail the turn and cancellation aborts the native session", async () => {
  const failing = fakeServer((call, push) => {
    if (call.path === "/session") return { id: SID };
    if (call.path.endsWith("/prompt_async")) setImmediate(() => {
      push({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } });
      push({ type: "session.error", properties: { sessionID: SID, error: { name: "ProviderAuthError", data: { providerID: "openrouter", message: "No auth credentials found" } } } });
      push({ type: "session.idle", properties: { sessionID: SID } });
    });
    return null;
  });
  const failed = collect(runOpencode({ agent: "opencode", command: "opencode", prompt: "x", cwd: "/w", systemPromptAppend: "", sessionId: "p", model: "m/x" }, async () => failing.server));
  assert.equal((await failed.exited).code, 1);
  assert.deepEqual(failed.events.at(-1)!.errors, ["ProviderAuthError: No auth credentials found"]);

  let aborted = false;
  const slow = fakeServer((call, push) => {
    if (call.path === "/session") return { id: SID };
    if (call.path.endsWith("/prompt_async")) setImmediate(() => push({ type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } }));
    if (call.path.endsWith("/abort")) {
      aborted = true;
      setImmediate(() => {
        push({ type: "session.error", properties: { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
        push({ type: "session.idle", properties: { sessionID: SID } });
      });
    }
    return null;
  });
  const run = runOpencode({ agent: "opencode", command: "opencode", prompt: "x", cwd: "/w", systemPromptAppend: "", sessionId: "p", model: "m/x", onAccepted: () => setImmediate(() => run.kill()) }, async () => slow.server);
  const cancelled = collect(run);
  assert.deepEqual(await cancelled.exited, { code: null, signal: "SIGTERM", spawnError: null });
  assert.equal(aborted, true);
  assert.equal(cancelled.events.some((event) => event.type === "result"), false);

  const noModel = collect(runOpencode({ agent: "opencode", command: "opencode", prompt: "x", cwd: "/w", systemPromptAppend: "", sessionId: "p" }, async () => slow.server));
  assert.equal((await noModel.exited).code, 1);
  assert.match(String(noModel.events.at(-1)!.errors), /No OpenRouter model/);
});

test("the OpenRouter catalog keeps tool-capable models, newest first, with variants as efforts", () => {
  const models = normalizeOpencodeProviders({
    providers: [
      { id: "opencode", models: { free: { id: "free", capabilities: { toolcall: true } } } },
      { id: "openrouter", models: {
        old: { id: "anthropic/claude-sonnet-4", name: "Sonnet 4", release_date: "2025-05-01", capabilities: { toolcall: true }, limit: { context: 200000 } },
        new: { id: "openai/gpt-5.5", name: "GPT-5.5", release_date: "2026-08-01", capabilities: { toolcall: true }, variants: { low: {}, high: {}, "Bad Name": {} } },
        image: { id: "google/image", release_date: "2026-09-01", capabilities: { toolcall: false } },
        gone: { id: "x/old", status: "deprecated", capabilities: { toolcall: true } },
      } },
    ],
  });
  assert.deepEqual(models.map((model) => model.id), ["openai/gpt-5.5", "anthropic/claude-sonnet-4"]);
  assert.equal(models.find((model) => model.default)?.id, "anthropic/claude-sonnet-4");
  assert.deepEqual(models[0].reasoningEfforts, [{ id: "low", label: "Low" }, { id: "high", label: "High" }]);
});

test("helpers: outcome parsing, tool mapping, usage accounting and driver metadata", () => {
  assert.deepEqual(parseOutcomeText("Summary first {\"result\":\"failure\",\"summary\":\"no\"} trailing"), { result: "failure", summary: "no" });
  assert.equal(parseOutcomeText("no json here"), undefined);
  assert.deepEqual(canonicalTool("write", { filePath: "/a", content: "x" }), { name: "Write", input: { file_path: "/a", content: "x" } });
  assert.deepEqual(canonicalTool("peon_sessions_spawn", { a: 1 }), { name: "peon_sessions_spawn", input: { a: 1 } });

  const usage = new OpencodeUsage();
  const row = { model: "m", input: 10, output: 5, reasoning: 0, cacheRead: 3, cacheWrite: 0, cost: 0.1, total: 18 };
  assert.equal(usage.observe("a", row), true);
  assert.equal(usage.observe("a", row), false, "a repeated message update is not double-counted");
  usage.observe("b", { ...row, cost: 0.2 });
  assert.equal(Math.round(usage.cost() * 100) / 100, 0.3);

  const driver = getAgentDriver("opencode")!;
  assert.equal(agentServiceName(driver), "opencode");
  assert.equal(driver.tokenUsage.cacheIncludedInInput, false);
  assert.equal(canonicalUsageProvider("opencode"), "opencode");
  assert.equal(normalizeTokenUsage("opencode", { inputTokens: 600, outputTokens: 150, cacheReadInputTokens: 400 })?.uncachedInputTokens, 600);
  assert.ok(driver.services.loginRouter && driver.services.quota && driver.services.authStatus && driver.services.cliUpdate);
});

test("API-key login routes validate input, never echo the key and require an operator", async () => {
  const express = (await import("express")).default;
  const { createOpencodeLoginRouter, OpencodeLoginError } = await import("../agents/opencodeLoginRoutes.js");
  let stored: string | null = null;
  const service = {
    status: () => ({ loggedIn: stored !== null, keySource: stored ? "opencode" : null, keyHint: stored ? "sk-or-…1234" : null, error: null }),
    async setApiKey(key: string) { if (key === "sk-bad") throw new OpencodeLoginError(400, "INVALID_API_KEY", "OpenRouter rejected this API key"); stored = key; },
    async clearApiKey() { stored = null; },
  };
  const app = express();
  app.use(express.json());
  app.use("/driver/opencode", createOpencodeLoginRouter(() => service, (req) => req.headers["x-actor"] ? String(req.headers["x-actor"]) : null));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/driver/opencode`;
  const call = (method: string, route: string, body?: unknown, actor = "owner@example.test") => fetch(`${base}${route}`, {
    method, headers: { "content-type": "application/json", ...(actor ? { "x-actor": actor } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await call("GET", "/login", undefined, "")).status, 403);
    assert.equal((await call("POST", "/login", { apiKey: "sk-x", command: "rm" })).status, 400);
    assert.equal((await call("POST", "/login", { apiKey: "has space" })).status, 400);
    const rejected = await call("POST", "/login", { apiKey: "sk-bad" });
    assert.equal(rejected.status, 400);
    assert.equal(((await rejected.json()) as { code: string }).code, "INVALID_API_KEY");
    const ok = await call("POST", "/login", { apiKey: "sk-or-secret-1234" });
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.equal(text.includes("secret"), false, "the key is never echoed back");
    assert.equal(JSON.parse(text).loggedIn, true);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal((await call("POST", "/logout", {})).status, 200);
    assert.equal(((await (await call("GET", "/login")).json()) as { loggedIn: boolean }).loggedIn, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// End to end against the real CLI and a fake OpenRouter endpoint. Runs when an
// opencode binary is available (OPENCODE_TEST_COMMAND or `opencode` on PATH).
const realCommand = process.env.OPENCODE_TEST_COMMAND ?? "opencode";
const haveOpencode = await import("node:child_process").then(({ spawnSync }) => spawnSync(realCommand, ["--version"], { stdio: "ignore" }).status === 0);
test("real opencode: tool call, usage and fork against a fake OpenRouter", { skip: !haveOpencode && "opencode is not installed", timeout: 120_000 }, async () => {
  const http = await import("node:http");
  const requests: Array<Record<string, unknown>> = [];
  const chunk = (delta: unknown, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake/model", choices: [{ index: 0, delta, finish_reason: finish }] });
  const fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { model?: string; messages?: Array<{ role: string }>; tools?: Array<{ function?: { name?: string } }> };
      requests.push(parsed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 40 } };
      const toolTurn = parsed.model === "fake/model" && parsed.messages?.at(-1)?.role === "user" && parsed.tools?.some((tool) => tool.function?.name === "bash");
      const frames = toolTurn
        ? [chunk({ role: "assistant", content: "" }), chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hi", description: "say hi" }) } }] }), { ...chunk({}, "tool_calls"), usage }]
        : [chunk({ role: "assistant", content: "All done." }), { ...chunk({}, "stop"), usage }];
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as import("node:net").AddressInfo).port;
  const configDir = path.join(temp, "config", "opencode");
  (await import("node:fs")).mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({
    small_model: "openrouter/fake/model",
    provider: { openrouter: { options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-fake" }, models: { "fake/model": { name: "Fake", tool_call: true } } } },
  }));
  const cwd = mkdtempSync(path.join(temp, "work-"));
  try {
    const { forkOpencodeSession } = await import("../agents/opencode.js");
    const run = runOpencode({ agent: "opencode", command: realCommand, prompt: "run echo hi", cwd, systemPromptAppend: "PEON-SYSTEM", sessionId: "peon-real", model: "fake/model" });
    const { events, exited } = collect(run);
    assert.equal((await exited).code, 0, JSON.stringify(events.at(-1)));
    const init = events.find((event) => event.type === "system" && event.subtype === "init")!;
    assert.match(String(init.session_id), /^ses/);
    assert.ok(events.some((event) => JSON.stringify(event).includes("\"name\":\"Bash\"")), "the bash call is reported as Bash");
    assert.ok(events.some((event) => JSON.stringify(event).includes("hi\\n")), "the tool output is reported");
    const result = events.at(-1)!;
    assert.equal(result.result, "All done.");
    assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, reasoning_output_tokens: 0 });
    assert.ok(requests.some((request) => JSON.stringify(request).includes("PEON-SYSTEM")), "the system prompt reaches the model");

    const resumed = collect(runOpencode({ agent: "opencode", command: realCommand, prompt: "thanks", cwd, systemPromptAppend: "", sessionId: "peon-real", model: "fake/model", resume: true, backendSessionId: String(init.session_id) }));
    assert.equal((await resumed.exited).code, 0);
    const forked = await forkOpencodeSession({ command: realCommand, backendSessionId: String(init.session_id), cwd });
    assert.match(forked.backendSessionId, /^ses/);
    assert.notEqual(forked.backendSessionId, init.session_id);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});
