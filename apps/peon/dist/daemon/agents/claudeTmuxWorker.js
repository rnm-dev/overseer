// A private foreground tmux server belongs to the terminal supervisor's process
// group. Never connect to an operator's tmux server or persist terminal output.
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
const exec = promisify(execFile);
const socket = `peon-login-${randomUUID()}`;
const cli = process.argv[2];
const tmux = (...args) => exec("tmux", ["-L", socket, ...args], { maxBuffer: 128 * 1024 });
const server = spawn("tmux", ["-D", "-L", socket, "-f", "/dev/null"], { stdio: "ignore" });
let stopping = false;
let previous = "";
let input = "";
async function stop(code) {
    if (stopping)
        return;
    stopping = true;
    try {
        await tmux("kill-server");
    }
    catch { /* Already gone. */ }
    server.kill("SIGTERM");
    process.exit(code);
}
server.on("error", () => void stop(1));
server.on("exit", () => { if (!stopping)
    void stop(1); });
process.on("SIGTERM", () => void stop(1));
process.on("SIGINT", () => void stop(1));
process.stdin.on("end", () => void stop(1));
process.stdout.on("error", () => void stop(1));
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
try {
    let ready = false;
    for (let i = 0; i < 40 && !stopping; i++) {
        try {
            await tmux("set-option", "-g", "remain-on-exit", "on");
            ready = true;
            break;
        }
        catch {
            await delay();
        }
    }
    if (!ready || !cli)
        throw new Error("tmux unavailable");
    // Multiple command arguments avoid shell interpretation of the CLI path.
    await tmux("new-session", "-d", "-s", "login", "-x", "5000", "-y", "40", cli, "auth", "login", "--claudeai");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
        input += chunk;
        const end = input.indexOf("\n");
        if (end < 0)
            return;
        const code = input.slice(0, end);
        input = "";
        // Defense in depth: never interpret terminal controls or tmux key names.
        if (!/^[A-Za-z0-9_.~#%+/=-]{1,4096}$/.test(code)) {
            void stop(1);
            return;
        }
        void tmux("send-keys", "-t", "login:0.0", "-l", "--", code)
            .then(() => tmux("send-keys", "-t", "login:0.0", "Enter"))
            .catch(() => stop(1));
    });
    while (!stopping) {
        const { stdout } = await tmux("capture-pane", "-p", "-J", "-t", "login:0.0", "-S", "-100");
        if (stdout !== previous) {
            process.stdout.write(stdout);
            previous = stdout;
        }
        const state = await tmux("display-message", "-p", "-t", "login:0.0", "#{pane_dead}:#{pane_dead_status}");
        if (state.stdout.startsWith("1:")) {
            const code = Number.parseInt(state.stdout.slice(2), 10);
            await stop(Number.isInteger(code) ? code : 1);
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}
catch {
    await stop(1);
}
