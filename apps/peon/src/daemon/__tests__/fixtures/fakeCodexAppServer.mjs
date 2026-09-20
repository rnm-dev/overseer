import readline from "node:readline";

const version = process.env.FAKE_CODEX_VERSION || "0.144.5";
if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sendThreadReply = (message) => setTimeout(() => send(message), Number(process.env.FAKE_THREAD_RPC_DELAY_MS ?? 0));
let initialized = false;
let experimentalApi = false;
let threadCounter = 0;
let turnCounter = 0;
const receivedRequests = [];
const activeTurns = new Map();
const threadTurns = new Map();

const textInput = (input) => (Array.isArray(input) ? input : [])
  .filter((item) => item?.type === "text")
  .map((item) => String(item.text ?? ""))
  .join("\n");

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (typeof message.method === "string" && !["initialize", "initialized", "test/requests"].includes(message.method)) {
    receivedRequests.push({ method: message.method, params: message.params });
  }
  if (message.method === "initialize") {
    experimentalApi = message.params?.capabilities?.experimentalApi === true;
    send({ id: message.id, result: { userAgent: `fake/${version}`, platformFamily: "test", platformOs: "test" } });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    if (process.env.FAKE_EXIT_AFTER_INITIALIZED === "1") setTimeout(() => process.exit(24), 5);
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: "Not initialized" } });
    return;
  }
  if (message.method === "thread/start") {
    if (message.params?.runtimeWorkspaceRoots && !experimentalApi) {
      send({ id: message.id, error: { code: -32602, message: "thread/start.runtimeWorkspaceRoots requires experimentalApi capability" } });
      return;
    }
    const threadId = `thread-${++threadCounter}`;
    threadTurns.set(threadId, []);
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params?.model ?? "fake-model", reasoningEffort: null } });
    send({ method: "thread/started", params: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "thread/resume") {
    if (!threadTurns.has(message.params.threadId)) threadTurns.set(message.params.threadId, []);
    sendThreadReply({ id: message.id, result: { thread: { id: message.params.threadId }, model: "fake-model", reasoningEffort: null } });
    return;
  }
  if (message.method === "thread/fork") {
    if (process.env.FAKE_FORK_UNSUPPORTED === "1") {
      send({ id: message.id, error: { code: -32000, message: "paginated_threads is not supported yet" } });
      return;
    }
    const sourceTurns = threadTurns.get(message.params.threadId);
    if (!sourceTurns) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    const threadId = `thread-${++threadCounter}`;
    const lastTurnIndex = message.params.lastTurnId
      ? sourceTurns.findIndex((turn) => turn.id === message.params.lastTurnId)
      : sourceTurns.length - 1;
    threadTurns.set(threadId, structuredClone(sourceTurns.slice(0, lastTurnIndex + 1)));
    sendThreadReply({ id: message.id, result: { thread: { id: threadId, forkedFromId: message.params.threadId } } });
    send({ method: "thread/started", params: { thread: { id: threadId, forkedFromId: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${++turnCounter}`;
    const threadId = message.params.threadId;
    const prompt = textInput(message.params.input);
    activeTurns.set(threadId, { turnId, prompt, params: message.params });
    threadTurns.get(threadId)?.push({ id: turnId, status: "inProgress", items: [], itemsView: "full", error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null });
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    const delay = prompt.includes("[SLOW]") ? 40 : 0;
    setTimeout(() => {
      const active = activeTurns.get(threadId);
      if (!active || active.turnId !== turnId) return;
      activeTurns.delete(threadId);
      const persistedTurn = threadTurns.get(threadId)?.find((turn) => turn.id === turnId);
      const completedAtMs = Date.now();
      const commandOutput = prompt.includes("[LARGE_OUTPUT]") ? `start-${"😀".repeat(1_100_000)}-end` : "tests passed";
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs, item: { type: "commandExecution", id: `${turnId}-cmd`, command: "npm test", cwd: process.cwd(), status: "completed", aggregatedOutput: commandOutput, exitCode: 0 } } });
      send({ method: "item/fileChange/patchUpdated", params: { threadId, turnId, itemId: `${turnId}-edit`, changes: [{ path: "src/example.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }] } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs, item: { type: "fileChange", id: `${turnId}-edit`, status: "completed", changes: [{ path: "src/example.ts", kind: "update" }] } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs, item: { type: "mcpToolCall", id: `${turnId}-mcp`, server: "peon", tool: "status", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null }, error: null } } });
      const reply = active.params.outputSchema ? JSON.stringify({ result: "success", summary: `reply:${threadId}` }) : `reply:${threadId}:${active.prompt.split("\n").at(-1)}`;
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs, item: { type: "agentMessage", id: `${turnId}-message`, text: reply, phase: "final_answer" } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: {}, last: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 7, totalTokens: 18, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
      if (prompt.includes("[REROUTE]")) send({ method: "model/rerouted", params: { threadId, turnId, fromModel: message.params.model ?? "fake-model", toModel: "rerouted-model", reason: "fallback" } });
      if (prompt.includes("[FAIL]")) {
        if (persistedTurn) persistedTurn.status = "failed";
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "fake turn failure" }, durationMs: 5, completedAt: Date.now() / 1000 } } });
      } else {
        if (persistedTurn) persistedTurn.status = "completed";
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null, durationMs: 5, completedAt: Date.now() / 1000 } } });
      }
    }, delay);
    return;
  }
  if (message.method === "turn/steer") {
    const active = activeTurns.get(message.params.threadId);
    if (!active || active.turnId !== message.params.expectedTurnId) {
      send({ id: message.id, error: { code: -32602, message: "expectedTurnId is not the active turn" } });
      return;
    }
    const prompt = textInput(message.params.input);
    if (prompt.includes("[STEER_FAIL]")) {
      send({ id: message.id, error: { code: -32001, message: "fake steer failure" } });
      return;
    }
    active.prompt += `\n${prompt}`;
    send({ id: message.id, result: { turnId: active.turnId } });
    return;
  }
  if (message.method === "turn/interrupt") {
    activeTurns.delete(message.params.threadId);
    const persistedTurn = threadTurns.get(message.params.threadId)?.find((turn) => turn.id === message.params.turnId);
    if (persistedTurn) persistedTurn.status = "interrupted";
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", error: null, durationMs: 1, completedAt: Date.now() / 1000 } } });
    return;
  }
  if (message.method === "thread/read") {
    const turns = threadTurns.get(message.params.threadId);
    if (!turns) {
      send({ id: message.id, error: { code: -32000, message: "thread not found" } });
      return;
    }
    sendThreadReply({ id: message.id, result: { thread: { id: message.params.threadId, turns: message.params.includeTurns ? turns : [] } } });
    return;
  }
  if (message.method === "test/echo") {
    setTimeout(() => send({ id: message.id, result: message.params }), Number(message.params?.delay ?? 0));
    return;
  }
  if (message.method === "test/route") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: message.params.turnId } } });
    return;
  }
  if (message.method === "test/hang") return;
  if (message.method === "test/late") {
    setTimeout(() => send({ id: message.id, result: { late: true } }), 250);
    return;
  }
  if (message.method === "test/malformed") {
    process.stdout.write("{definitely not json}\n");
    return;
  }
  if (message.method === "test/crash") {
    setTimeout(() => process.exit(23), 5);
    return;
  }
  if (message.method === "test/serverRequest") {
    send({ id: message.id, result: {} });
    send({ id: "server-request-1", method: "approval/request", params: message.params });
    return;
  }
  if (message.method === "test/serverRequestNamed") {
    send({ id: message.id, result: {} });
    send({ id: "server-request-1", method: message.params.method, params: message.params.params ?? {} });
    return;
  }
  if (message.method === "test/requests") {
    send({ id: message.id, result: receivedRequests });
    return;
  }
  if (message.method === "test/serverRequestWithoutHandler") {
    send({ id: message.id, result: {} });
    send({ id: "server-request-1", method: "approval/missing", params: message.params });
    return;
  }
  if (message.method === "test/serverRequestAndCrash") {
    send({ id: message.id, result: {} });
    send({ id: "server-request-1", method: "approval/slow", params: message.params });
    setTimeout(() => process.exit(25), 5);
    return;
  }
  if (message.id === "server-request-1") {
    send({ method: "test/serverResponse", params: message });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });
});
