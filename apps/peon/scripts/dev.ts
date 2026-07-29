#!/usr/bin/env -S node --import tsx
// Runs the daemon + dashboard together as a drop-in replacement for the
// systemd units — same ports (4570/4571), same XDG config/state (so it's
// the same real settings/credentials/sessions, not a separate instance),
// same restrictive PATH (no shell-profile inheritance) and Restart=always-
// style auto-restart on crash. The dashboard server keeps tsx watch hot reload,
// while the daemon intentionally runs without watch so deploying or editing
// source cannot interrupt an in-flight session. Restart the harness manually
// after finishing work when daemon changes need to take effect.
// Only ever run one of {this, the systemd services} at a time — both bind
// the same ports.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");
const HOME = os.homedir();

// Two long-lived harnesses can each win one of the daemon/dashboard ports,
// leaving a mixed-version pair serving the same state directory. Take an
// atomic per-user lock before spawning either child. A stale lock left by an
// ungraceful exit is reclaimed only when its recorded process no longer exists.
const STATE_ROOT = path.join(process.env.XDG_STATE_HOME || path.join(HOME, ".local", "state"), ".peon");
const HARNESS_LOCK = path.join(STATE_ROOT, "dev-harness.lock");

function processIsDevHarness(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM still means a process owns this PID. Inspect it below rather than
    // treating a recycled PID belonging to another user as our harness.
  }

  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return command.includes("scripts/dev.ts");
  } catch {
    // If the host cannot inspect an existing process, preserve the lock. It is
    // safer to require manual recovery than to launch a second live harness.
    return true;
  }
}

function acquireHarnessLock(): void {
  mkdirSync(STATE_ROOT, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(HARNESS_LOCK, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(readFileSync(HARNESS_LOCK, "utf8"), 10);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      if (Number.isInteger(owner) && owner > 0 && processIsDevHarness(owner)) {
        throw new Error(`another Peon dev harness is already running (pid ${owner})`);
      }
      rmSync(HARNESS_LOCK, { force: true });
    }
  }
  throw new Error("could not acquire the Peon dev harness lock");
}

function releaseHarnessLock(): void {
  try {
    if (Number.parseInt(readFileSync(HARNESS_LOCK, "utf8"), 10) === process.pid) {
      rmSync(HARNESS_LOCK, { force: true });
    }
  } catch {
    // The lock was already removed or replaced; never remove another owner.
  }
}

acquireHarnessLock();
process.once("exit", releaseHarnessLock);

const CONTROL_PORT = process.env.ACA_CONTROL_PORT ?? "4570";
const DASHBOARD_PORT = process.env.ACA_DASHBOARD_PORT ?? "4571";

// Mirrors the daemon unit's own `Environment=PATH=...` override — systemd
// user services don't inherit a shell profile, so a dev run should hit the
// same "is this on PATH?" failures production would (e.g. the agent CLI
// living in ~/.local/bin) rather than silently passing via a dev shell's
// broader PATH.
const SYSTEMD_LIKE_PATH = [
  path.join(HOME, ".local", "bin"),
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
  // The dir of the node binary running this harness — on Linux/systemd boxes
  // node is already under one of the above, but a Homebrew macOS box keeps it
  // in /opt/homebrew/bin, which the systemd-mirroring list intentionally omits.
  // Without this the spawned children can't find `node` at all ("env: node: No
  // such file or directory"). This doesn't weaken the "is the agent CLI on
  // PATH?" check the restricted PATH exists for.
  path.dirname(process.execPath),
].join(":");

const sharedEnv = {
  ...process.env,
  PATH: SYSTEMD_LIKE_PATH,
};

interface ProcDef {
  name: string;
  color: string;
  script: string;
  watch: boolean;
  env: Record<string, string | undefined>;
}

const procs: ProcDef[] = [
  { name: "daemon", color: "36", script: "src/daemon/index.ts", watch: false, env: { ...sharedEnv, ACA_CONTROL_PORT: CONTROL_PORT } },
  { name: "dashboard", color: "35", script: "src/dashboard/server.ts", watch: true, env: { ...sharedEnv, ACA_DASHBOARD_PORT: DASHBOARD_PORT } },
];

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

function prefixLines(name: string, color: string, chunk: Buffer, stream: NodeJS.WriteStream): void {
  const label = `\x1b[${color}m[${name}]\x1b[0m `;
  const lines = chunk.toString().split("\n");
  const trailing = lines.pop();
  for (const line of lines) stream.write(`${label}${line}\n`);
  if (trailing) stream.write(`${label}${trailing}`);
}

function launch(def: ProcDef): void {
  if (shuttingDown) return;
  const child = spawn(TSX_BIN, def.watch ? ["watch", def.script] : [def.script], { cwd: ROOT, env: def.env });
  children.set(def.name, child);

  child.stdout?.on("data", (chunk) => prefixLines(def.name, def.color, chunk, process.stdout));
  child.stderr?.on("data", (chunk) => prefixLines(def.name, def.color, chunk, process.stderr));

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[${def.name}] exited (code ${code}, signal ${signal}) — restarting in 2s (Restart=always, like the unit file)`);
    setTimeout(() => launch(def), 2000);
  });
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n==> shutting down dev harness");
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const def of procs) launch(def);

console.log(`
peon dev harness — daemon + dashboard (dashboard server hot reloads on save).
Drop-in replacement for the systemd units: same ports, same config/state,
same PATH restriction, Restart=always-style crash recovery. Don't run this
at the same time as the systemd services — they'd fight over the same
ports.

Daemon source changes require a manual dev-harness restart to take effect.

  daemon    : http://127.0.0.1:${CONTROL_PORT}
  dashboard : http://127.0.0.1:${DASHBOARD_PORT}
`);
