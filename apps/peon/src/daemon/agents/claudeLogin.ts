import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { runTerminalCommand, startTerminal, type TerminalFactory, type TerminalProcess } from "./terminalHarness.js";

export interface ClaudeLoginAttempt {
  id: string;
  status: "starting" | "awaiting_code" | "verifying" | "succeeded" | "failed" | "cancelled" | "expired";
  authorizationUrl: string | null;
  expiresAt: number;
  pollAfterMs: number;
  error: string | null;
}
export class ClaudeLoginError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
interface Attempt {
  owner: string;
  view: ClaudeLoginAttempt;
  process?: TerminalProcess;
  probe?: TerminalProcess;
  output: string;
  ttl?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setTimeout>;
  probeRetry?: ReturnType<typeof setTimeout>;
  probeAttempts?: number;
  retirement?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
}
export class ClaudeLoginService {
  private attempt?: Attempt;
  private logoutOperation?: Promise<void>;
  constructor(private readonly options: {
    command: () => string;
    terminal?: TerminalFactory;
    ttlMs?: number;
    retentionMs?: number;
    verificationRetryMs?: number;
    verificationTimeoutMs?: number;
    onLogout?: () => void;
    onSuccess?: () => void;
  }) {}
  private pending(a: Attempt) { return ["starting", "awaiting_code", "verifying"].includes(a.view.status); }
  current(owner: string): ClaudeLoginAttempt | null {
    const a = this.attempt;
    return a?.owner === owner ? { ...a.view } : null;
  }
  get(owner: string, id: string): ClaudeLoginAttempt { return { ...this.require(owner, id).view }; }
  private require(owner: string, id: string): Attempt {
    if (!this.attempt || this.attempt.owner !== owner || this.attempt.view.id !== id) {
      throw new ClaudeLoginError(404, "LOGIN_NOT_FOUND", "Login attempt not found or expired");
    }
    return this.attempt;
  }
  start(owner: string): ClaudeLoginAttempt {
    if (this.logoutOperation) throw new ClaudeLoginError(409, "LOGOUT_IN_PROGRESS", "Sign-out is in progress");
    const previous = this.attempt;
    if (previous && this.pending(previous)) {
      if (previous.owner === owner) return { ...previous.view };
      throw new ClaudeLoginError(409, "LOGIN_IN_PROGRESS", "A Claude login is already in progress");
    }
    if (previous?.cleanup) throw new ClaudeLoginError(409, "LOGIN_CLEANING_UP", "Previous login is closing; retry shortly");
    if (previous?.retirement) clearTimeout(previous.retirement);
    const ttlMs = this.options.ttlMs ?? 600_000;
    const a: Attempt = { owner, output: "", view: {
      id: randomUUID(), status: "starting", authorizationUrl: null,
      expiresAt: Date.now() + ttlMs, pollAfterMs: 1500, error: null,
    } };
    this.attempt = a;
    a.ttl = setTimeout(() => this.finish(a, "expired"), ttlMs);
    a.ttl.unref();
    try {
      a.process = (this.options.terminal ?? startTerminal)({
        command: this.options.terminal ? this.options.command() : process.execPath,
        args: this.options.terminal ? ["auth", "login", "--claudeai"] : [
          ...process.execArgv,
          fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./claudeTmuxWorker.ts" : "./claudeTmuxWorker.js", import.meta.url)),
          this.options.command(),
        ],
        env: { ...process.env, BROWSER: "/usr/bin/false", NO_COLOR: "1" },
        onData: (text) => this.output(a, text),
        onExit: (code) => {
          if (!this.pending(a)) return;
          if (code === 0) this.verify(a);
          else this.finish(a, "failed", "Claude login exited unsuccessfully. Check that tmux and the configured Claude CLI are installed, then try again.");
        },
      });
    } catch { this.finish(a, "failed", "Could not start Claude login. Check the configured CLI."); }
    return { ...a.view };
  }
  private output(a: Attempt, chunk: string) {
    if (!this.pending(a) || a.view.status === "verifying") return;
    a.output = (a.output + chunk).slice(-32_768);
    const text = stripVTControlCharacters(a.output);
    for (const match of text.matchAll(/https:\/\/[^\s\x00-\x1f<>"']+/g)) {
      try {
        const url = new URL(match[0]);
        if (["claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"].includes(url.hostname)
          && url.pathname.endsWith("/oauth/authorize") && !url.username && !url.password
          && url.searchParams.has("state") && url.searchParams.has("code_challenge")) {
          a.view.authorizationUrl = url.href;
        }
      } catch { /* May be an incomplete output chunk. */ }
    }
    if (a.view.authorizationUrl && text.includes("Paste code")) a.view.status = "awaiting_code";
  }
  submitCode(owner: string, id: string, code: unknown): ClaudeLoginAttempt {
    const a = this.require(owner, id);
    if (a.view.status !== "awaiting_code") throw new ClaudeLoginError(409, "LOGIN_NOT_WAITING", "Claude is not waiting for a code");
    if (typeof code !== "string" || !/^[A-Za-z0-9_.~#%+\/=-]{1,4096}$/.test(code)) {
      throw new ClaudeLoginError(400, "INVALID_LOGIN_CODE", "A single authorization code is required");
    }
    a.view.status = "verifying";
    a.view.authorizationUrl = null;
    a.output = "";
    try { a.process!.write(`${code}\n`); }
    catch { this.finish(a, "failed", "Claude login closed before receiving the code"); }
    return { ...a.view };
  }
  private verify(a: Attempt) {
    a.view.status = "verifying";
    a.output = "";
    a.probeAttempts = 0;
    a.probeTimer = setTimeout(
      () => this.finish(a, "failed", "Claude authentication verification timed out"),
      this.options.verificationTimeoutMs ?? 10_000,
    );
    a.probeTimer.unref();
    this.probeAuthentication(a);
  }
  private probeAuthentication(a: Attempt) {
    if (!this.pending(a)) return;
    let output = "";
    a.probeAttempts = (a.probeAttempts ?? 0) + 1;
    try {
      a.probe = (this.options.terminal ?? startTerminal)({
        command: this.options.command(), args: ["auth", "status", "--json"],
        onData: (chunk) => { output = (output + chunk).slice(-16_384); },
        onExit: () => {
          if (!this.pending(a)) return;
          let loggedIn = false;
          try { loggedIn = JSON.parse(output).loggedIn === true; } catch { /* Invalid status. */ }
          output = "";
          if (loggedIn) {
            this.finish(a, "succeeded");
            this.options.onSuccess?.();
            return;
          }
          const completedProbe = a.probe;
          a.probe = undefined;
          void completedProbe?.stop().then(() => {
            if (!this.pending(a)) return;
            if ((a.probeAttempts ?? 0) >= 4) {
              this.finish(a, "failed", "Claude did not confirm authentication");
              return;
            }
            const delayMs = (this.options.verificationRetryMs ?? 250) * (a.probeAttempts ?? 1);
            a.probeRetry = setTimeout(() => this.probeAuthentication(a), delayMs);
            a.probeRetry.unref();
          });
        },
      });
    } catch { this.finish(a, "failed", "Could not verify Claude authentication"); }
  }
  cancel(owner: string, id: string) {
    const a = this.require(owner, id);
    if (this.pending(a)) this.finish(a, "cancelled");
    return { ...a.view };
  }
  private finish(a: Attempt, status: ClaudeLoginAttempt["status"], error: string | null = null) {
    if (!this.pending(a)) return;
    clearTimeout(a.ttl); clearTimeout(a.probeTimer); clearTimeout(a.probeRetry);
    a.view = { ...a.view, status, error, authorizationUrl: null, pollAfterMs: 0 };
    a.output = "";
    a.cleanup = Promise.all([a.process?.stop(), a.probe?.stop()]).then(() => {
      a.process = undefined; a.probe = undefined; a.cleanup = undefined;
    });
    a.retirement = setTimeout(() => { if (this.attempt === a) this.attempt = undefined; }, this.options.retentionMs ?? 60_000);
    a.retirement.unref();
  }
  async logout(): Promise<void> {
    if (this.logoutOperation || (this.attempt && (this.pending(this.attempt) || this.attempt.cleanup))) {
      throw new ClaudeLoginError(409, "AUTH_IN_PROGRESS", "Wait for the current authentication operation to finish");
    }
    if (this.attempt) clearTimeout(this.attempt.retirement);
    this.attempt = undefined;
    this.logoutOperation = runTerminalCommand(this.options.command(), ["auth", "logout"], this.options.terminal);
    try {
      await this.logoutOperation;
      this.options.onLogout?.();
    } catch { throw new ClaudeLoginError(502, "LOGOUT_FAILED", "Could not sign out. Check the provider CLI and retry."); }
    finally { this.logoutOperation = undefined; }
  }
  async shutdown() {
    await this.logoutOperation?.catch(() => {});
    const a = this.attempt;
    if (!a) return;
    if (this.pending(a)) this.finish(a, "cancelled");
    clearTimeout(a.retirement);
    await a.cleanup;
    this.attempt = undefined;
  }
}
