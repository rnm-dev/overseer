import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentEvent, AgentExit, AgentRun } from "./executor.js";

type RawAgentEvent = Record<string, unknown>;

export function spawnJsonAgent(
  command: string,
  args: string[],
  cwd: string,
  normalize: (event: RawAgentEvent, emit: (event: AgentEvent) => void) => void,
  stdinInput?: string,
): AgentRun {
  const emitter = new EventEmitter();
  const child = spawn(command, args, { cwd, stdio: [stdinInput === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (stdinInput !== undefined) {
    // A CLI that exits before consuming all input can close the pipe early;
    // that is reported by its own exit event, not as an unhandled stream error.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdinInput);
  }
  let buffer = "";
  const lines: string[] = [];
  let lineIndex = 0;
  let processing = false;
  let pendingExit: AgentExit | null = null;
  let stdoutEnded = false;
  const emit = (event: AgentEvent) => emitter.emit("event", event);

  const emitExitWhenDrained = () => {
    if (!pendingExit || !stdoutEnded || processing || lineIndex < lines.length) return;
    const exit = pendingExit;
    pendingExit = null;
    emitter.emit("exit", exit);
  };

  // Limit each parser turn. Previously a tool-heavy stdout burst was drained
  // completely inside one `data` callback, including all downstream event
  // handlers and persistence, starving HTTP for seconds under concurrent runs.
  const processLines = () => {
    processing = true;
    const deadline = performance.now() + 8;
    while (lineIndex < lines.length) {
      const line = lines[lineIndex++];
      try {
        normalize(JSON.parse(line) as RawAgentEvent, emit);
      } catch {
        emit({ type: "stderr", text: `unparseable stdout line: ${line}` });
      }
      if (performance.now() >= deadline) break;
    }
    if (lineIndex < lines.length) {
      setImmediate(processLines);
      return;
    }
    lines.length = 0;
    lineIndex = 0;
    processing = false;
    emitExitWhenDrained();
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      lines.push(line);
    }
    if (!processing && lineIndex < lines.length) setImmediate(processLines);
  });
  child.stdout!.on("end", () => {
    stdoutEnded = true;
    emitExitWhenDrained();
  });
  child.stderr!.on("data", (chunk: Buffer) => emit({ type: "stderr", text: chunk.toString("utf8") }));
  child.on("error", (err) => {
    emitter.emit("exit", { code: null, signal: null, spawnError: err.message } satisfies AgentExit);
  });
  child.on("exit", (code, signal) => {
    pendingExit = { code, signal, spawnError: null } satisfies AgentExit;
    emitExitWhenDrained();
  });

  return {
    emitter,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      child.kill(signal);
    },
  };
}
