// Small parent-death supervisor. No provider logic, files, or output capture.
import { spawn } from "node:child_process";
let child;
let stopping = false;
const signal = (name) => {
    if (!child?.pid)
        return;
    try {
        process.kill(-child.pid, name);
    }
    catch { /* Group already exited. */ }
};
function stop() {
    if (stopping)
        return;
    stopping = true;
    process.stdin.unpipe();
    child?.stdin?.destroy();
    signal("SIGTERM");
    setTimeout(() => { signal("SIGKILL"); process.exit(0); }, 300);
}
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdout.on("error", stop);
process.stderr.on("error", stop);
process.once("message", (message) => {
    if (stopping || message.type !== "start")
        return;
    try {
        child = spawn(message.command, message.args, { detached: true, stdio: ["pipe", "inherit", "inherit"] });
        process.stdin.pipe(child.stdin);
        child.stdin.on("error", stop);
        child.on("error", () => {
            if (process.connected)
                process.send?.({ type: "exit", code: null }, () => { });
            stop();
        });
        child.on("exit", (code) => {
            if (process.connected)
                process.send?.({ type: "exit", code }, () => { });
            stop();
        });
    }
    catch {
        stop();
    }
});
