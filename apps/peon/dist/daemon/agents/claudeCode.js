import { sourceTimestampMetadata } from "../sessions/index.js";
import { guardToolOutput } from "../sessions/index.js";
import { spawnJsonAgent } from "./spawnJsonAgent.js";
import { normalizeFileToolInput } from "./toolPaths.js";
import { claudeUsage, claudeResultUsage, ClaudeInputAccumulator } from "./claudeUsage.js";
export function buildClaudeCodeArgs(opts) {
    const args = [
        "-p", opts.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", opts.permissionMode ?? "bypassPermissions",
        "--append-system-prompt", opts.systemPromptAppend,
        ...(opts.resume ? ["--resume", opts.backendSessionId ?? opts.sessionId] : ["--session-id", opts.sessionId]),
        "--setting-sources", "project",
        "--strict-mcp-config",
    ];
    if (opts.outcomeSchema)
        args.push("--json-schema", JSON.stringify(opts.outcomeSchema));
    if (opts.mcpConfigPath) {
        args.push("--mcp-config", opts.mcpConfigPath);
        if (opts.allowedTools)
            args.push("--allowedTools", opts.allowedTools);
    }
    if (opts.maxBudgetUsd)
        args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    if (opts.model)
        args.push("--model", opts.model);
    if (opts.reasoningEffort)
        args.push("--effort", opts.reasoningEffort);
    return args;
}
// Claude's stream-json shape inspired the original transcript renderer, but it
// is still treated as provider input here—not as the storage contract. Copy
// only fields the shared harness/history understands so a CLI-specific event
// cannot leak into persisted or live session output.
export function normalizeClaudeCodeEvent(raw, cwd) {
    const type = raw.type;
    const sourceTimestamp = sourceTimestampMetadata(raw);
    if (type === "system") {
        // A content-free heartbeat every second or two while the model thinks.
        // Persisted, it filled the newest transcript page and crowded out the
        // conversation, so it never becomes a transcript event.
        if (raw.subtype === "thinking_tokens")
            return null;
        return {
            type: "system",
            ...(typeof raw.subtype === "string" ? { subtype: raw.subtype } : {}),
            ...(typeof raw.session_id === "string" ? { session_id: raw.session_id } : {}),
            ...(typeof raw.model === "string" ? { model: raw.model } : {}),
            ...sourceTimestamp,
        };
    }
    if (type === "assistant" || type === "user") {
        const message = raw.message ?? {};
        const content = Array.isArray(message.content)
            ? message.content.filter((part) => {
                const partType = part?.type;
                return partType === "text" || partType === "tool_use" || partType === "tool_result";
            }).map((part) => {
                if (!part || typeof part !== "object" || part.type !== "tool_use")
                    return part;
                const tool = part;
                return { ...tool, input: normalizeFileToolInput(tool.name, tool.input, cwd) };
            })
            : [];
        return {
            type,
            message: {
                ...(typeof message.id === "string" ? { id: message.id } : {}),
                ...(message.usage ? { usage: claudeUsage(message.usage) } : {}),
                ...(typeof message.model === "string" ? { model: message.model } : {}),
                content,
            },
            ...sourceTimestamp,
        };
    }
    if (type === "result") {
        const fields = [
            "subtype", "is_error", "result", "errors", "structured_output",
            "num_turns", "duration_ms", "total_cost_usd", "usage", "model",
        ];
        const event = { type: "result" };
        for (const field of fields) {
            if (raw[field] !== undefined)
                event[field] = raw[field];
        }
        return { ...event, ...claudeResultUsage(raw), ...sourceTimestamp };
    }
    // Rate-limit/progress/provider diagnostics are not conversation history.
    // Represent them as ignorable system metadata without retaining raw payloads.
    if (typeof type === "string")
        return { type: "system", subtype: "provider_event", event_type: type, ...sourceTimestamp };
    return null;
}
export function createClaudeCodeEventNormalizer(opts, guard = guardToolOutput) {
    let accepted = false;
    const usage = new ClaudeInputAccumulator();
    return (raw, emit) => {
        const event = normalizeClaudeCodeEvent(raw, opts.cwd);
        if (!event)
            return;
        const providerAccepted = raw.type === "assistant" || raw.type === "user"
            || (raw.type === "system" && raw.subtype === "init");
        if (!accepted && providerAccepted) {
            accepted = true;
            opts.onAccepted?.();
        }
        if (event.type !== "user") {
            if (usage.observe(raw))
                emit({ type: "system", subtype: "usage", ...usage.report() });
            if (event.type === "result" && event.subtype === "error_during_execution"
                && Object.values(event.usage).every((value) => value === 0)) {
                Object.assign(event, usage.report());
            }
            emit(event);
            return;
        }
        const message = event.message;
        const content = Array.isArray(message?.content) ? message.content : [];
        const warnings = [];
        const guardedContent = content.map((part) => {
            if (!part || typeof part !== "object")
                return part;
            const toolResult = part;
            if (toolResult.type !== "tool_result" || typeof toolResult.content !== "string")
                return part;
            const guarded = guard(opts.sessionId, String(toolResult.tool_use_id ?? "tool"), toolResult.content, "tool_output");
            if (guarded.warning)
                warnings.push(guarded.warning);
            return { ...toolResult, content: guarded.content };
        });
        emit({ ...event, message: { ...message, content: guardedContent } });
        for (const warning of warnings)
            emit({ type: "warning", ...warning, ...sourceTimestampMetadata(raw) });
    };
}
export function runClaudeCode(opts) {
    return spawnJsonAgent(opts.command, buildClaudeCodeArgs(opts), opts.cwd, createClaudeCodeEventNormalizer(opts));
}
export function forkClaudeCodeSession(input) {
    return new Promise((resolve, reject) => {
        let reportedSessionId = null;
        let providerError = null;
        const run = spawnJsonAgent(input.command, [
            "-p", "",
            "--output-format", "stream-json",
            "--verbose",
            "--permission-mode", "bypassPermissions",
            "--resume", input.backendSessionId,
            "--fork-session",
            "--session-id", input.targetSessionId,
            "--setting-sources", "project",
            "--strict-mcp-config",
        ], input.cwd, (raw, emit) => {
            if (typeof raw.session_id === "string")
                reportedSessionId = raw.session_id;
            if (raw.type === "result" && raw.is_error === true) {
                providerError = Array.isArray(raw.errors) ? raw.errors.map(String).join("; ") : String(raw.result ?? "Claude session fork failed");
            }
            emit({ type: "system", subtype: "provider_event" });
        });
        const timeout = setTimeout(() => {
            run.kill();
            reject(new Error("Claude session fork timed out"));
        }, 30_000);
        timeout.unref();
        run.emitter.once("exit", (exit) => {
            clearTimeout(timeout);
            if (providerError)
                return reject(new Error(providerError));
            if (exit.spawnError)
                return reject(new Error(exit.spawnError));
            if (exit.code !== 0)
                return reject(new Error(`Claude session fork exited with code ${String(exit.code)}`));
            if (reportedSessionId !== input.targetSessionId)
                return reject(new Error("Claude session fork returned an unexpected session id"));
            resolve({ backendSessionId: reportedSessionId });
        });
    });
}
