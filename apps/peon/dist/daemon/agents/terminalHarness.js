import { fork } from "node:child_process";
export const startTerminal = (options) => {
    const worker = new URL(import.meta.url.endsWith(".ts") ? "./terminalWorker.ts" : "./terminalWorker.js", import.meta.url);
    const child = fork(worker, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"], env: options.env ?? process.env,
    });
    let stopping;
    let ended = false;
    let result = null;
    const stop = () => stopping ??= new Promise((resolve) => {
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        child.stdin.destroy();
        if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
        }
        child.once("exit", () => resolve());
        // Closing IPC is also the crash path: the supervisor kills its child group.
        if (child.connected)
            child.disconnect();
    });
    const exit = () => {
        if (ended)
            return;
        ended = true;
        if (!stopping)
            options.onExit(result);
        void stop();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => options.onData(text));
    child.stderr.on("data", (text) => (options.onStderr ?? options.onData)(text));
    child.stdin.on("error", exit);
    child.on("error", exit);
    child.on("message", (message) => {
        const m = message;
        if (m?.type === "exit")
            result = typeof m.code === "number" ? m.code : null;
    });
    child.on("exit", exit);
    child.send({ type: "start", command: options.command, args: options.args });
    return {
        write(text) {
            if (stopping || ended || !child.stdin.writable)
                throw new Error("Terminal is closed");
            child.stdin.write(text);
        },
        stop,
    };
};
