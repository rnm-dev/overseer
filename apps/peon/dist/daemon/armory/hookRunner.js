import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { armoryHookEventSchema, armoryHookOutputSchema, MAX_HOOK_OUTPUT_BYTES, MAX_LIFECYCLE_MS, } from "./contracts.js";
import { ArmoryOperationError } from "./operationCoordinator.js";
import { resolveContainedPath } from "./paths.js";
import { createArmoryRedactor } from "./redaction.js";
import { ARMORY_COMMAND_PATH } from "./runtimeEnvironment.js";
const MAX_HOOK_LINES = 1000;
const KILL_GRACE_MS = 1000;
export class ArmoryHookError extends ArmoryOperationError {
    stderr;
    constructor(code, message, stderr = "", options) {
        super(code, message, options);
        this.stderr = stderr;
        this.name = "ArmoryHookError";
    }
}
export class ArmoryHookRunner {
    async run(options) {
        const input = armoryHookEventSchema.parse(options.input);
        const redactor = createArmoryRedactor(options.sensitiveValues ?? []);
        const resolved = await resolveHookCommand(options.command, options.packageDir);
        const timeoutMs = Math.min(options.timeoutMs ?? MAX_LIFECYCLE_MS, MAX_LIFECYCLE_MS);
        const maxBytes = Math.min(options.maxOutputBytes ?? MAX_HOOK_OUTPUT_BYTES, MAX_HOOK_OUTPUT_BYTES);
        return new Promise((resolve, reject) => {
            const child = spawn(resolved.executable, resolved.args, {
                cwd: options.packageDir,
                env: {
                    PATH: ARMORY_COMMAND_PATH,
                    HOME: options.managedHome,
                    PEON_ARMORY_PACKAGE_DIR: options.packageDir,
                    PEON_ARMORY_HOME: options.managedHome,
                    ...options.environment,
                },
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
            });
            let stdout = "";
            let stderr = "";
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let timedOut = false;
            let outputExceeded = false;
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
            }, timeoutMs);
            child.stdout.on("data", (chunk) => {
                stdoutBytes += chunk.byteLength;
                if (stdoutBytes > maxBytes) {
                    outputExceeded = true;
                    child.kill("SIGTERM");
                    return;
                }
                stdout += chunk.toString("utf8");
            });
            child.stderr.on("data", (chunk) => {
                stderrBytes += chunk.byteLength;
                if (stderrBytes <= maxBytes)
                    stderr += chunk.toString("utf8");
                else {
                    outputExceeded = true;
                    child.kill("SIGTERM");
                }
            });
            child.on("error", (error) => {
                clearTimeout(timer);
                reject(new ArmoryHookError("HOOK_START_FAILED", "Package hook could not be started", redactor.text(stderr), { cause: error }));
            });
            child.on("close", (code, signal) => {
                clearTimeout(timer);
                void finishHook({ code, signal, stdout, stderr, timedOut, outputExceeded, redactor, options }).then(resolve, reject);
            });
            child.stdin.on("error", () => undefined);
            child.stdin.end(`${JSON.stringify(input)}\n`);
        });
    }
}
async function finishHook(context) {
    const safeStderr = context.redactor.text(context.stderr).slice(0, MAX_HOOK_OUTPUT_BYTES);
    if (context.timedOut)
        throw new ArmoryHookError("HOOK_TIMEOUT", "Package hook timed out", safeStderr);
    if (context.outputExceeded)
        throw new ArmoryHookError("HOOK_OUTPUT_LIMIT", "Package hook exceeded its output limit", safeStderr);
    if (context.code !== 0)
        throw new ArmoryHookError("HOOK_EXIT_NONZERO", `Package hook exited unsuccessfully${context.signal ? ` (${context.signal})` : ""}`, safeStderr);
    const rawLines = context.stdout.split("\n");
    if (rawLines.at(-1) === "")
        rawLines.pop();
    if (rawLines.length > MAX_HOOK_LINES)
        throw new ArmoryHookError("HOOK_OUTPUT_LIMIT", "Package hook emitted too many protocol events", safeStderr);
    let result = null;
    for (const raw of rawLines) {
        if (!raw.trim())
            throw new ArmoryHookError("HOOK_PROTOCOL_INVALID", "Package hook emitted non-protocol output", safeStderr);
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new ArmoryHookError("HOOK_PROTOCOL_INVALID", "Package hook emitted malformed JSON", safeStderr);
        }
        const checked = armoryHookOutputSchema.safeParse(parsed);
        if (!checked.success)
            throw new ArmoryHookError("HOOK_PROTOCOL_INVALID", "Package hook emitted an invalid protocol event", safeStderr);
        const event = context.redactor.value(checked.data);
        if (event.type === "progress") {
            if (result)
                throw new ArmoryHookError("HOOK_PROTOCOL_INVALID", "Package hook emitted progress after its result", safeStderr);
            await context.options.onProgress?.(event);
        }
        else {
            if (result)
                throw new ArmoryHookError("HOOK_DUPLICATE_RESULT", "Package hook emitted more than one result", safeStderr);
            result = event;
        }
    }
    if (!result)
        throw new ArmoryHookError("HOOK_RESULT_MISSING", "Package hook ended without a result", safeStderr);
    if (!result.ok)
        throw new ArmoryHookError(result.errorCode, result.message, safeStderr);
    const ownedPaths = result.ownedPaths ?? [];
    await context.options.validateOwnedPaths?.(ownedPaths);
    return { message: result.message, ownedPaths, stderr: safeStderr };
}
async function resolveHookCommand(command, packageDir) {
    if (command.executable === "node") {
        const script = command.args[0];
        if (!script || script.startsWith("-"))
            throw new ArmoryHookError("HOOK_COMMAND_INVALID", "Node hook must begin with a package-relative script");
        const scriptPath = resolveContainedPath(packageDir, script);
        const details = await lstat(scriptPath).catch(() => null);
        if (!details?.isFile())
            throw new ArmoryHookError("HOOK_COMMAND_INVALID", "Node hook script is not a regular package file");
        return { executable: process.execPath, args: [scriptPath, ...command.args.slice(1)] };
    }
    const executable = resolveContainedPath(packageDir, command.executable);
    const details = await lstat(executable).catch(() => null);
    if (!details?.isFile())
        throw new ArmoryHookError("HOOK_COMMAND_INVALID", "Hook executable is not a regular package file");
    return { executable, args: command.args };
}
