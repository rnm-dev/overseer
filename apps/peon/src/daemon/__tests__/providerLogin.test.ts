import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ClaudeLoginService } from "../agents/claudeLogin.js";
import { CodexLoginService } from "../agents/codexLogin.js";
import { startTerminal, type TerminalOptions, type TerminalFactory } from "../agents/terminalHarness.js";

function fakeTerminal() {
  const runs: Array<{ options: TerminalOptions; input: string[]; stopped: number }> = [];
  const terminal: TerminalFactory = (options) => {
    const run = { options, input: [] as string[], stopped: 0 }; runs.push(run);
    return { write: (text) => { run.input.push(text); }, stop: async () => { run.stopped++; } };
  };
  return { runs, terminal };
}
const url = "https://claude.com/cai/oauth/authorize?state=private-state&code_challenge=private-challenge";

test("Claude parses chunked terminal output, resumes one attempt and verifies CLI authentication", async () => {
  const { terminal, runs } = fakeTerminal();
  let success = 0;
  const service = new ClaudeLoginService({ command: () => "custom-claude", terminal, onSuccess: () => success++ });
  try {
    const a = service.start("owner");
    assert.equal(service.start("owner").id, a.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.command, "custom-claude");
    assert.deepEqual(runs[0].options.args, ["auth", "login", "--claudeai"]);
    assert.equal(service.current("owner")?.id, a.id);
    assert.equal(service.current("other"), null);
    assert.throws(() => service.start("other"), /already in progress/);
    assert.throws(() => service.get("other", a.id), /not found/);
    const output = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `;
    for (let i = 0; i < output.length; i += 7) runs[0].options.onData(output.slice(i, i + 7));
    assert.equal(service.get("owner", a.id).authorizationUrl, url);
    assert.equal(service.get("owner", a.id).status, "awaiting_code");
    assert.throws(() => service.submitCode("other", a.id, "secret"), /not found/);
    assert.throws(() => service.submitCode("owner", a.id, "a\ncommand"), /single authorization/);
    const submitted = service.submitCode("owner", a.id, "private-code#private-state");
    assert.equal(submitted.status, "verifying");
    assert.equal(submitted.authorizationUrl, null);
    assert.deepEqual(runs[0].input, ["private-code#private-state\n"]);
    assert.throws(() => service.submitCode("owner", a.id, "again"), /not waiting/);
    runs[0].options.onData("private-code#private-state");
    runs[0].options.onExit(0);
    assert.deepEqual(runs[1].options.args, ["auth", "status", "--json"]);
    runs[1].options.onData('{"loggedIn":true}');
    runs[1].options.onExit(0);
    assert.equal(service.get("owner", a.id).status, "succeeded");
    assert.equal(success, 1);
    assert.equal(runs[0].stopped, 1);
    assert.equal(runs[1].stopped, 1);
    assert.doesNotMatch(JSON.stringify(service.get("owner", a.id)), /private/);
    assert.equal(service.cancel("owner", a.id).status, "succeeded");
  } finally { await service.shutdown(); }
});

test("Claude rejects unexpected URLs and cleans up cancellation, expiry and late callbacks", async () => {
  const { terminal, runs } = fakeTerminal();
  const service = new ClaudeLoginService({ command: () => "claude", terminal, ttlMs: 20, retentionMs: 20 });
  try {
    const a = service.start("owner");
    runs[0].options.onData("https://evil.test/oauth/authorize?state=x&code_challenge=y\nPaste code here > ");
    assert.equal(service.get("owner", a.id).authorizationUrl, null);
    service.cancel("owner", a.id);
    runs[0].options.onExit(0);
    assert.equal(runs.length, 1);
    assert.equal(service.get("owner", a.id).status, "cancelled");
    await delay(30);
    assert.equal(service.current("owner"), null);
    const b = service.start("owner");
    await delay(25);
    assert.equal(service.get("owner", b.id).status, "expired");
    assert.equal(runs[1].stopped, 1);
    await delay(25);
    assert.equal(service.current("owner"), null);
  } finally { await service.shutdown(); }
});

test("Claude does not mistake a successful command exit for confirmed sign-in", async () => {
  const { terminal, runs } = fakeTerminal();
  const service = new ClaudeLoginService({ command: () => "claude", terminal });
  const a = service.start("owner");
  runs[0].options.onExit(0);
  runs[1].options.onData('{"loggedIn":false}');
  runs[1].options.onExit(0);
  assert.equal(service.get("owner", a.id).status, "failed");
  await service.shutdown();
  assert.equal(service.current("owner"), null);
});

function rpc(options: TerminalOptions, message: unknown) { options.onData(`${JSON.stringify(message)}\n`); }
const device = { type: "chatgptDeviceCode", loginId: "provider-id", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };

test("Codex uses its device protocol and waits for completion of the exact login attempt", async () => {
  const { terminal, runs } = fakeTerminal();
  const service = new CodexLoginService({ command: () => "codex", terminal });
  try {
    const a = service.start("owner");
    assert.equal(service.start("owner").id, a.id);
    assert.throws(() => service.cancel("other", a.id), /not found/);
    rpc(runs[0].options, { id: 1, result: {} });
    assert.equal(JSON.parse(runs[0].input[2]).params.type, "chatgptDeviceCode");
    rpc(runs[0].options, { id: 2, result: device });
    assert.equal(service.get("owner", a.id).userCode, "ABCD-1234");
    rpc(runs[0].options, { method: "account/updated", params: { authMode: "chatgpt" } });
    rpc(runs[0].options, { method: "account/login/completed", params: { loginId: "other", success: true } });
    assert.equal(service.get("owner", a.id).status, "waiting_for_authorization");
    rpc(runs[0].options, { method: "account/login/completed", params: { loginId: "provider-id", success: true } });
    const done = service.get("owner", a.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.pollAfterMs, 0);
    assert.equal(done.userCode, null);
    assert.equal(done.verificationUrl, null);
    assert.equal(runs[0].stopped, 1);
  } finally { await service.shutdown(); }
});

test("Codex handles early completion, cancellation races, timeout and malformed provider data", async () => {
  for (const mode of ["early", "cancel", "expire", "malformed"] as const) {
    const { terminal, runs } = fakeTerminal();
    const service = new CodexLoginService({ command: () => "codex", terminal, ttlMs: 25 });
    try {
      const a = service.start("owner");
      rpc(runs[0].options, { id: 1, result: {} });
      if (mode === "early") rpc(runs[0].options, { method: "account/login/completed", params: { loginId: "provider-id", success: true } });
      rpc(runs[0].options, { id: 2, result: mode === "malformed" ? { ...device, verificationUrl: "https://evil.test/" } : device });
      if (mode === "cancel") {
        service.cancel("owner", a.id);
        assert.equal(JSON.parse(runs[0].input.at(-1)!).method, "account/login/cancel");
        rpc(runs[0].options, { method: "account/login/completed", params: { loginId: "provider-id", success: true } });
      }
      if (mode === "expire") await delay(35);
      assert.equal(service.get("owner", a.id).status, { early: "succeeded", cancel: "cancelled", expire: "expired", malformed: "failed" }[mode]);
      assert.equal(runs[0].stopped, 1);
    } finally { await service.shutdown(); }
  }
});

test("terminal harness exchanges stdin/stdout and bounds shutdown of a stubborn process group", async () => {
  let pid = 0;
  let text = "";
  const terminal = startTerminal({
    command: process.execPath,
    args: ["-e", 'process.on("SIGTERM",()=>{}); process.stdout.write(String(process.pid)+"\\n"); process.stdin.on("data",b=>process.stdout.write(b));'],
    onData: (chunk) => { text += chunk; pid = Number(text.split("\n")[0]); },
    onExit: () => {},
  });
  try {
    for (let i = 0; !pid && i < 100; i++) await delay(10);
    assert(pid > 0);
    terminal.write("hello\n");
    for (let i = 0; !text.includes("hello") && i < 100; i++) await delay(10);
    assert.match(text, /hello/);
    await terminal.stop();
    await delay(30);
    assert.throws(() => process.kill(pid, 0));
    assert.throws(() => terminal.write("after stop"), /closed/);
    await terminal.stop();
  } finally { await terminal.stop(); }
});

test("terminal supervisor reaps CLI and descendants after abrupt parent death", async () => {
  const parent = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/terminalParent.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let pids: { child: number; grandchild: number } | undefined;
  parent.stdout.on("data", (chunk) => { output += chunk; });
  parent.stderr.resume();
  try {
    for (let i = 0; !output.includes("\n") && i < 200; i++) await delay(10);
    pids = JSON.parse(output.trim());
    assert(pids);
    parent.kill("SIGKILL");
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; (alive(pids.child) || alive(pids.grandchild)) && i < 200; i++) await delay(10);
    assert.equal(alive(pids.child), false);
    assert.equal(alive(pids.grandchild), false);
  } finally {
    parent.kill("SIGKILL");
    for (const pid of Object.values(pids ?? {})) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

test("installed Claude emits a remote authorization URL and cancels cleanly", { skip: !process.env.PEON_LOGIN_SMOKE }, async () => {
  const service = new ClaudeLoginService({ command: () => process.env.PEON_LOGIN_SMOKE!, ttlMs: 15_000 });
  try {
    const a = service.start("smoke-test");
    for (let i = 0; service.get("smoke-test", a.id).status === "starting" && i < 100; i++) await delay(100);
    assert.equal(service.get("smoke-test", a.id).status, "awaiting_code");
    assert(service.get("smoke-test", a.id).authorizationUrl?.startsWith("https://claude."));
    service.cancel("smoke-test", a.id);
    assert.equal(service.get("smoke-test", a.id).authorizationUrl, null);
  } finally { await service.shutdown(); }
});

test("installed Codex supplies a device code and cancels cleanly", { skip: !process.env.PEON_CODEX_LOGIN_SMOKE }, async () => {
  const service = new CodexLoginService({ command: () => process.env.PEON_CODEX_LOGIN_SMOKE!, ttlMs: 30_000 });
  try {
    const a = service.start("smoke-test");
    for (let i = 0; service.get("smoke-test", a.id).status === "starting" && i < 200; i++) await delay(100);
    assert.equal(service.get("smoke-test", a.id).status, "waiting_for_authorization", service.get("smoke-test", a.id).error ?? undefined);
    assert(service.get("smoke-test", a.id).userCode);
    service.cancel("smoke-test", a.id);
    assert.equal(service.get("smoke-test", a.id).userCode, null);
  } finally { await service.shutdown(); }
});
