import { execFileSync } from "node:child_process";
import os from "node:os";
export const DAEMON_SYSTEMD_UNIT = "peon-daemon.service";
export const DAEMON_LAUNCHD_LABEL = "dev.peon.daemon";
function launchdTarget(uid) {
    return `gui/${uid}/${DAEMON_LAUNCHD_LABEL}`;
}
export function daemonRestartCommand(platform = process.platform, uid = os.userInfo().uid) {
    if (platform === "darwin") {
        return {
            command: "launchctl",
            args: ["kickstart", "-k", launchdTarget(uid)],
            displayName: DAEMON_LAUNCHD_LABEL,
        };
    }
    return {
        command: "systemctl",
        args: ["--user", "restart", DAEMON_SYSTEMD_UNIT],
        displayName: DAEMON_SYSTEMD_UNIT,
    };
}
export function daemonStatusCommand(platform = process.platform, uid = os.userInfo().uid) {
    if (platform === "darwin") {
        return {
            command: "launchctl",
            args: ["print", launchdTarget(uid)],
            displayName: DAEMON_LAUNCHD_LABEL,
        };
    }
    return {
        command: "systemctl",
        args: ["--user", "status", DAEMON_SYSTEMD_UNIT, "--no-pager"],
        displayName: DAEMON_SYSTEMD_UNIT,
    };
}
export function restartDaemonService() {
    const command = daemonRestartCommand();
    execFileSync(command.command, command.args, { stdio: "inherit" });
}
export function printDaemonServiceStatus() {
    const command = daemonStatusCommand();
    execFileSync(command.command, command.args, { stdio: "inherit" });
}
