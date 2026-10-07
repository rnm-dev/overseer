import { randomUUID } from "node:crypto";
import { runTerminalCommand, startTerminal, type TerminalFactory, type TerminalProcess } from "./terminalHarness.js";

export interface CodexLoginAttempt {
  id: string;
  status: "starting" | "waiting_for_authorization" | "succeeded" | "failed" | "cancelled" | "expired";
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number;
  pollAfterMs: number;
  error: string | null;
}
export class CodexLoginError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
interface Attempt {
  owner: string;
  view: CodexLoginAttempt;
  loginId?: string;
  process?: TerminalProcess;
  buffer: string;
  ttl?: ReturnType<typeof setTimeout>;
  startup?: ReturnType<typeof setTimeout>;
  retirement?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
  earlyCompletion?: { loginId?: unknown; success?: unknown };
}

// Codex owns device-code polling. Peon's clients poll these snapshots while the
// dedicated app-server delivers account/login/completed for the exact loginId.
export class CodexLoginService {
  private attempt?: Attempt;
  private logoutOperation?: Promise<void>;
  constructor(private readonly options: {
    command: () => string;
    terminal?: TerminalFactory;
    ttlMs?: number;
    retentionMs?: number;
    onLogout?: () => void;
  }) {}
  private pending(a: Attempt) { return ["starting", "waiting_for_authorization"].includes(a.view.status); }
  current(owner: string): CodexLoginAttempt | null {
    return this.attempt?.owner === owner ? { ...this.attempt.view } : null;
  }
  private require(owner: string, id: string) {
    const a = this.attempt;
    if (!a || a.owner !== owner || a.view.id !== id) throw new CodexLoginError(404, "LOGIN_NOT_FOUND", "Login attempt not found or expired");
    return a;
  }
  get(owner: string, id: string) { return { ...this.require(owner, id).view }; }
  start(owner: string): CodexLoginAttempt {
    if (this.logoutOperation) throw new CodexLoginError(409, "LOGOUT_IN_PROGRESS", "Sign-out is in progress");
    const previous = this.attempt;
    if (previous && this.pending(previous)) {
      if (previous.owner === owner) return { ...previous.view };
      throw new CodexLoginError(409, "LOGIN_IN_PROGRESS", "A Codex login is already in progress");
    }
    if (previous?.cleanup) throw new CodexLoginError(409, "LOGIN_CLEANING_UP", "Previous login is closing; retry shortly");
    clearTimeout(previous?.retirement);
    const ttlMs = this.options.ttlMs ?? 600_000;
    const a: Attempt = { owner, buffer: "", view: {
      id: randomUUID(), status: "starting", verificationUrl: null, userCode: null,
      expiresAt: Date.now() + ttlMs, pollAfterMs: 1500, error: null,
    } };
    this.attempt = a;
    a.ttl = setTimeout(() => this.finish(a, "expired"), ttlMs); a.ttl.unref();
    a.startup = setTimeout(() => this.finish(a, "failed", "Codex login initialization timed out"), 30_000); a.startup.unref();
    try {
      a.process = (this.options.terminal ?? startTerminal)({
        command: this.options.command(), args: ["-s", "read-only", "-a", "never", "app-server"],
        env: { ...process.env, BROWSER: "/usr/bin/false" },
        onData: (chunk) => this.output(a, chunk), onStderr: () => {},
        onExit: () => this.finish(a, "failed", "Codex login process exited before completing sign-in"),
      });
      this.send(a, { id: 1, method: "initialize", params: { clientInfo: { name: "peon-login", version: "1.0.0" } } });
    } catch { this.finish(a, "failed", "Could not start Codex login. Check the configured CLI."); }
    return { ...a.view };
  }
  private send(a: Attempt, message: unknown) {
    try { a.process!.write(`${JSON.stringify(message)}\n`); }
    catch { this.finish(a, "failed", "Codex login transport closed"); }
  }
  private output(a: Attempt, chunk: string) {
    if (!this.pending(a)) return;
    a.buffer += chunk;
    if (a.buffer.length > 131_072) { this.finish(a, "failed", "Codex login response exceeded its limit"); return; }
    let newline: number;
    while (this.pending(a) && (newline = a.buffer.indexOf("\n")) >= 0) {
      const line = a.buffer.slice(0, newline); a.buffer = a.buffer.slice(newline + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!m || typeof m !== "object") continue;
      if ((m.id === 1 || m.id === 2) && m.error) {
        this.finish(a, "failed", "Codex rejected device-code login. Check CLI support and enable device-code authentication in your ChatGPT security settings.");
      } else if (m.id === 1 && m.result) {
        this.send(a, { method: "initialized", params: {} });
        this.send(a, { id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } });
      } else if (m.id === 2 && m.result) {
        const r = m.result;
        let url: URL | undefined;
        try { url = new URL(r.verificationUrl); } catch { /* Invalid URL. */ }
        if (r.type !== "chatgptDeviceCode" || typeof r.loginId !== "string" || !r.loginId
          || !url || url.protocol !== "https:" || url.hostname !== "auth.openai.com" || url.username || url.password
          || typeof r.userCode !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(r.userCode)) {
          this.finish(a, "failed", "Codex returned an unsupported device-code response"); continue;
        }
        clearTimeout(a.startup);
        a.loginId = r.loginId;
        a.view = { ...a.view, status: "waiting_for_authorization", verificationUrl: url.href, userCode: r.userCode };
        if (a.earlyCompletion) this.completed(a, a.earlyCompletion);
      } else if (m.method === "account/login/completed" && m.params) {
        if (!a.loginId) a.earlyCompletion = { loginId: m.params.loginId, success: m.params.success };
        else this.completed(a, m.params);
      }
    }
  }
  private completed(a: Attempt, result: { loginId?: unknown; success?: unknown }) {
    if (result.loginId !== a.loginId) return;
    this.finish(a, result.success === true ? "succeeded" : "failed", result.success === true ? null : "Codex sign-in was not completed. Try again.");
  }
  cancel(owner: string, id: string) {
    const a = this.require(owner, id);
    this.finish(a, "cancelled");
    return { ...a.view };
  }
  private finish(a: Attempt, status: CodexLoginAttempt["status"], error: string | null = null) {
    if (!this.pending(a)) return;
    a.view = { ...a.view, status, error, userCode: null, verificationUrl: null, pollAfterMs: 0 };
    clearTimeout(a.ttl); clearTimeout(a.startup);
    if (a.loginId && status !== "succeeded") {
      try { a.process?.write(`${JSON.stringify({ id: 3, method: "account/login/cancel", params: { loginId: a.loginId } })}\n`); } catch { /* Already closed. */ }
    }
    a.buffer = ""; a.loginId = undefined; a.earlyCompletion = undefined;
    a.cleanup = Promise.resolve(a.process?.stop()).then(() => { a.process = undefined; a.cleanup = undefined; });
    a.retirement = setTimeout(() => { if (this.attempt === a) this.attempt = undefined; }, this.options.retentionMs ?? 60_000);
    a.retirement.unref();
  }
  async logout(): Promise<void> {
    if (this.logoutOperation || (this.attempt && (this.pending(this.attempt) || this.attempt.cleanup))) {
      throw new CodexLoginError(409, "AUTH_IN_PROGRESS", "Wait for the current authentication operation to finish");
    }
    if (this.attempt) clearTimeout(this.attempt.retirement);
    this.attempt = undefined;
    this.logoutOperation = runTerminalCommand(this.options.command(), ["logout"], this.options.terminal);
    try {
      await this.logoutOperation;
      this.options.onLogout?.();
    } catch { throw new CodexLoginError(502, "LOGOUT_FAILED", "Could not sign out. Check the provider CLI and retry."); }
    finally { this.logoutOperation = undefined; }
  }
  async shutdown() {
    await this.logoutOperation?.catch(() => {});
    const a = this.attempt;
    if (!a) return;
    this.finish(a, "cancelled"); clearTimeout(a.retirement);
    await a.cleanup;
    this.attempt = undefined;
  }
}
