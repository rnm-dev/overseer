import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
export class OpencodeHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "OpencodeHttpError";
    }
}
const LISTENING = /opencode server listening on (http:\/\/[^\s]+)/;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const MAX_STARTUP_OUTPUT = 16 * 1024;
function killTree(child, signal) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
        return;
    try {
        // The server runs tools (bash, LSPs) as descendants; signal the group.
        if (process.platform !== "win32")
            process.kill(-child.pid, signal);
        else
            child.kill(signal);
    }
    catch {
        child.kill(signal);
    }
}
export async function startOpencodeServer(options) {
    const password = randomBytes(24).toString("base64url");
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const child = spawn(options.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            ...options.env,
            OPENCODE_SERVER_PASSWORD: password,
            // Peon owns CLI updates through the driver's updater.
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            ...(options.config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config) } : {}),
        },
    });
    const exitListeners = [];
    let exited = false;
    const exitedPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => {
            exited = true;
            for (const listener of exitListeners)
                listener(code, signal);
            resolve();
        });
    });
    const baseUrl = await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => {
            killTree(child, "SIGKILL");
            reject(new Error(`opencode serve did not start within ${Math.round((options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS) / 1000)}s`));
        }, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
        const onData = (chunk) => {
            if (output.length < MAX_STARTUP_OUTPUT)
                output += chunk.toString("utf8");
            const match = LISTENING.exec(output);
            if (!match)
                return;
            clearTimeout(timer);
            child.stdout?.off("data", onData);
            child.stderr?.off("data", onData);
            resolve(match[1].replace(/\/$/, ""));
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`opencode is unavailable: ${error.message}`));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            const detail = output.trim().split("\n").slice(-3).join(" ").slice(0, 500);
            reject(new Error(`opencode serve exited with code ${String(code)} before listening${detail ? `: ${detail}` : ""}`));
        });
    });
    // Keep draining output so a chatty server never blocks on a full pipe.
    child.stdout?.resume();
    child.stderr?.resume();
    const url = (path, directory) => {
        const target = new URL(path, `${baseUrl}/`);
        if (directory)
            target.searchParams.set("directory", directory);
        return target;
    };
    async function request(method, path, opts = {}) {
        const response = await fetch(url(path, opts.directory ?? options.cwd), {
            method,
            headers: { authorization, ...(opts.body === undefined ? {} : { "content-type": "application/json" }) },
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
        });
        const text = await response.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : null;
        }
        catch {
            parsed = text;
        }
        if (!response.ok) {
            const data = parsed && typeof parsed === "object" ? parsed.data : undefined;
            const message = typeof data?.message === "string" ? data.message : typeof parsed === "string" ? parsed : `HTTP ${response.status}`;
            throw new OpencodeHttpError(response.status, `opencode ${method} ${path} failed: ${message.slice(0, 500)}`);
        }
        return parsed;
    }
    async function* events(signal, directory) {
        const response = await fetch(url("/event", directory ?? options.cwd), { headers: { authorization, accept: "text/event-stream" }, signal });
        if (!response.ok || !response.body)
            throw new OpencodeHttpError(response.status, `opencode event stream failed: HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    return;
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                let boundary;
                while ((boundary = buffer.indexOf("\n\n")) >= 0) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
                    if (!data)
                        continue;
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && typeof parsed === "object")
                            yield parsed;
                    }
                    catch {
                        // A malformed frame is skipped; the next one is independent.
                    }
                }
            }
        }
        catch (error) {
            if (signal.aborted)
                return;
            throw error;
        }
        finally {
            reader.releaseLock();
        }
    }
    return {
        baseUrl,
        request,
        events,
        onExit(listener) {
            if (exited)
                listener(child.exitCode, child.signalCode);
            else
                exitListeners.push(listener);
        },
        async stop() {
            if (exited)
                return;
            killTree(child, "SIGTERM");
            const force = setTimeout(() => killTree(child, "SIGKILL"), 3_000);
            force.unref?.();
            await exitedPromise;
            clearTimeout(force);
        },
    };
}
// Run `fn` against a short-lived server and always stop it.
export async function withOpencodeServer(options, fn) {
    const server = await startOpencodeServer(options);
    try {
        return await fn(server);
    }
    finally {
        await server.stop();
    }
}
