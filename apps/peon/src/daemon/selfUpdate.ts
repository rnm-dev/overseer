import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessions } from "./sessions/index.js";
import { stateDir } from "./xdgPaths.js";
import { isGitCheckout } from "../shared/repo.js";

// Repo root of *this* install, whichever shape it is — the compiled updater
// lives at dist/cli/update.js under it. Same computation controlServer used
// before this logic moved here: dist/daemon/selfUpdate.js → .. → dist → .. → root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface SelfUpdateResult {
  // Whether the updater was actually launched.
  started: boolean;
  // True when a session is running and `force` wasn't set — the caller should
  // surface a 409 and offer force. Distinct from a plain failure.
  busy: boolean;
  // Source checkouts update files in place but leave the dev daemon running.
  manualRestartRequired: boolean;
  logPath: string;
}

// Launches the detached self-updater (dist/cli/update.js). Shared by the human
// POST /api/v1/control/update and the fleet-facing POST /api/v1/control/update
// so both trigger the exact same update, refusing (unless forced) while a
// session is live because the restart the updater performs kills it.
export function startSelfUpdate(opts: {
  force: boolean;
  command?: {
    commandId: string;
    expectedVersion: string | null;
    expectedRevision: string | null;
    expectedSha256: string | null;
  };
}): SelfUpdateResult {
  const logPath = path.join(stateDir(), "update.log");
  const force = opts.force;
  const sourceCheckout = isGitCheckout(REPO_ROOT);

  if (!sourceCheckout && sessions.isBusy() && !force) {
    return { started: false, busy: true, manualRestartRequired: false, logPath };
  }
  if (!sourceCheckout && sessions.isBusy() && force) {
    console.warn("update: force=true — proceeding despite an active session; it will be killed by the restart");
  }

  mkdirSync(stateDir(), { recursive: true });

  // update.js runs from the compiled dist/ of *this* repo (REPO_ROOT), whichever install
  // shape we are — but how we detach it differs, because how it restarts differs:
  //
  //  - Global install (systemd-managed): the restart update.js triggers sends SIGTERM to this
  //    process's whole systemd cgroup, and plain detached+unref only escapes Node's bookkeeping
  //    and the OS process group/session, not that cgroup — a naively-detached script would get
  //    killed mid-run by its own restart. systemd-run launches it as a brand-new transient unit
  //    (own cgroup, supervised by the user systemd instance) so it survives.
  //
  //  - Source checkout (`npm run dev`; the only option on macOS, which has no systemd): update.js
  //    updates files without restarting the daemon. A plain detached+unref child is enough, and
  //    systemd-run doesn't exist to call anyway. We tee stdout/stderr to update.log ourselves
  //    since there's no unit capturing it.
  const child = sourceCheckout
    ? spawn(process.execPath, [path.join(REPO_ROOT, "dist/cli/update.js")], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", openSync(logPath, "a"), openSync(logPath, "a")],
        env: {
          ...process.env,
          ...(force ? { FORCE: "1" } : {}),
          ...(opts.command ? {
            PEON_UPDATE_COMMAND_ID: opts.command.commandId,
            PEON_UPDATE_EXPECTED_VERSION: opts.command.expectedVersion ?? "",
            PEON_UPDATE_EXPECTED_REVISION: opts.command.expectedRevision ?? "",
            PEON_UPDATE_EXPECTED_SHA256: opts.command.expectedSha256 ?? "",
            PEON_UPDATE_INITIATOR_PID: String(process.pid),
          } : {}),
        },
      })
    : spawn(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--unit=peon-update",
          `--property=StandardOutput=append:${logPath}`,
          `--property=StandardError=append:${logPath}`,
          // A transient unit starts with its own minimal environment, not the caller's — the
          // spawned script re-checks for an active session itself (see src/cli/update.ts's own
          // comment on why), so its FORCE=1 escape hatch has to be forwarded explicitly here,
          // not just passed to this `spawn()` call's own (irrelevant) environment.
          ...(force ? ["--setenv=FORCE=1"] : []),
          ...(opts.command ? [
            `--setenv=PEON_UPDATE_COMMAND_ID=${opts.command.commandId}`,
            `--setenv=PEON_UPDATE_EXPECTED_VERSION=${opts.command.expectedVersion ?? ""}`,
            `--setenv=PEON_UPDATE_EXPECTED_REVISION=${opts.command.expectedRevision ?? ""}`,
            `--setenv=PEON_UPDATE_EXPECTED_SHA256=${opts.command.expectedSha256 ?? ""}`,
            `--setenv=PEON_UPDATE_INITIATOR_PID=${process.pid}`,
          ] : []),
          // …and, critically, PATH. The transient unit's minimal PATH is /usr/bin-ish, which has
          // git/systemctl but NOT the node/npm bin dir when node was installed via nvm/volta/etc
          // (that dir is only on the login PATH the daemon unit bakes in — see systemdUnits.ts).
          // Without this, update.js's `npm install -g` dies with `spawnSync npm ENOENT` before it
          // ever pulls or restarts. Forward the daemon's own PATH so npm resolves the same way it
          // does for the daemon (which itself was launched with that baked PATH).
          `--setenv=PATH=${process.env.PATH ?? ""}`,
          "--",
          process.execPath,
          path.join(REPO_ROOT, "dist/cli/update.js"),
        ],
        { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
  child.unref();
  child.stderr?.on("data", (chunk) => console.error("update: systemd-run:", chunk.toString()));
  // A missing `systemd-run` (or any spawn failure) otherwise surfaces only as an unhandled
  // 'error' event — log it instead of letting it take the daemon down.
  child.on("error", (err) => console.error("update: failed to spawn updater:", err));

  return { started: true, busy: false, manualRestartRequired: sourceCheckout, logPath };
}
