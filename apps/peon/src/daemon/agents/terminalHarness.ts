import { fork } from "node:child_process";

// Transport only. Providers own parsing, login state, deadlines and credentials.
// Pipes suffice for both Claude auth login and Codex app-server; no shell or log files.
export interface TerminalProcess {
  write(text: string): void;
  stop(): Promise<void>;
}
export interface TerminalOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onData(text: string): void;
  onStderr?(text: string): void;
  onExit(code: number | null): void;
}
export type TerminalFactory = (options: TerminalOptions) => TerminalProcess;

export const startTerminal: TerminalFactory = (options) => {
  const worker = new URL(import.meta.url.endsWith(".ts") ? "./terminalWorker.ts" : "./terminalWorker.js", import.meta.url);
  const child = fork(worker, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"], env: options.env ?? process.env,
  });
  let stopping: Promise<void> | undefined;
  let ended = false;
  let result: number | null = null;
  const stop = () => stopping ??= new Promise<void>((resolve) => {
    child.stdout!.removeAllListeners("data");
    child.stderr!.removeAllListeners("data");
    child.stdin!.destroy();
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
    // Closing IPC is also the crash path: the supervisor kills its child group.
    if (child.connected) child.disconnect();
  });
  const exit = () => {
    if (ended) return;
    ended = true;
    if (!stopping) options.onExit(result);
    void stop();
  };
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (text: string) => options.onData(text));
  child.stderr!.on("data", (text: string) => (options.onStderr ?? options.onData)(text));
  child.stdin!.on("error", exit);
  child.on("error", exit);
  child.on("message", (message: unknown) => {
    const m = message as { type?: string; code?: unknown };
    if (m?.type === "exit") result = typeof m.code === "number" ? m.code : null;
  });
  child.on("exit", exit);
  child.send({ type: "start", command: options.command, args: options.args });
  return {
    write(text) {
      if (stopping || ended || !child.stdin!.writable) throw new Error("Terminal is closed");
      child.stdin!.write(text);
    },
    stop,
  };
};

// Bounded noninteractive CLI operation. Output is deliberately discarded.
export async function runTerminalCommand(command: string, args: string[], terminal: TerminalFactory = startTerminal, timeoutMs = 10_000): Promise<void> {
  let process: TerminalProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Provider command timed out")), timeoutMs);
      process = terminal({ command, args, onData() {}, onStderr() {}, onExit(code) {
        if (code === 0) resolve(); else reject(new Error("Provider command failed"));
      } });
    });
  } finally { clearTimeout(timer); await process?.stop(); }
}
