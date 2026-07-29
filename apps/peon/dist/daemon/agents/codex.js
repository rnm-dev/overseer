import { readFileSync } from "node:fs";
import { sourceTimestampMetadata } from "../agentEventMetadata.js";
import { spawnJsonAgent } from "./spawnJsonAgent.js";
import { projectRelativePath } from "./toolPaths.js";
import { guardToolOutput } from "../sessionPayloadGuard.js";
export const MAX_EDIT_DIFF_BYTES = 512 * 1024;
export const MAX_EDIT_DIFF_LINE_BYTES = 64 * 1024;
function utf8Prefix(value, maxBytes) {
    if (maxBytes <= 0)
        return "";
    const bytes = Buffer.from(value);
    if (bytes.length <= maxBytes)
        return value;
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80)
        end--;
    return bytes.subarray(0, end).toString("utf8");
}
function boundedDiff(value, remainingBytes) {
    const originalBytes = Buffer.byteLength(value);
    let truncated = originalBytes > remainingBytes;
    let diff = utf8Prefix(value, remainingBytes);
    // A single generated line must not defeat the invocation-level cap or make
    // transcript consumers allocate an unbounded line buffer.
    const lines = diff.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (Buffer.byteLength(lines[i]) <= MAX_EDIT_DIFF_LINE_BYTES)
            continue;
        lines[i] = utf8Prefix(lines[i], MAX_EDIT_DIFF_LINE_BYTES);
        truncated = true;
    }
    diff = lines.join("\n");
    return { diff, bytes: Buffer.byteLength(diff), truncated, originalBytes };
}
/** Preserve the patch emitted by Codex at execution time; never reconstruct it
 * from the later worktree. Older runtimes expose only path/kind metadata, which
 * remains readable but is explicitly marked as unavailable. */
export function normalizeCodexFileChanges(item, cwd) {
    const rawChanges = Array.isArray(item.changes) ? item.changes : [];
    let remainingBytes = MAX_EDIT_DIFF_BYTES;
    return rawChanges.map((raw) => {
        const change = raw && typeof raw === "object" ? raw : {};
        const normalized = {
            ...change,
            path: projectRelativePath(change.path, cwd),
            ...(Object.hasOwn(change, "oldPath")
                ? { oldPath: projectRelativePath(change.oldPath, cwd) }
                : {}),
        };
        // Some runtime versions call the per-file field `patch`. A top-level diff
        // is unambiguous only for a single-file invocation.
        const runtimeDiff = typeof change.diff === "string"
            ? change.diff
            : typeof change.patch === "string"
                ? change.patch
                : rawChanges.length === 1 && typeof item.diff === "string"
                    ? item.diff
                    : rawChanges.length === 1 && typeof item.patch === "string"
                        ? item.patch
                        : undefined;
        delete normalized.patch;
        if (runtimeDiff === undefined) {
            normalized.diffUnavailable = "runtime_did_not_expose_patch";
            return normalized;
        }
        const bounded = boundedDiff(runtimeDiff, remainingBytes);
        normalized.diff = bounded.diff;
        remainingBytes -= bounded.bytes;
        if (bounded.truncated) {
            normalized.diffTruncated = true;
            normalized.diffOriginalBytes = bounded.originalBytes;
        }
        return normalized;
    });
}
function tomlString(value) {
    return JSON.stringify(value);
}
// Codex reports all local shell work as command_execution. Give common
// read-only/development commands stable provider-neutral names so the
// transcript is scannable without losing the original command payload.
export function codexCommandToolName(command) {
    if (typeof command !== "string")
        return "Bash";
    let unwrapped = command.replace(/^\s*(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/, "").trim();
    if ((unwrapped.startsWith('"') && unwrapped.endsWith('"')) || (unwrapped.startsWith("'") && unwrapped.endsWith("'"))) {
        unwrapped = unwrapped.slice(1, -1).trim();
    }
    // Multiple commands can perform unrelated work; don't pretend the whole
    // invocation is a read/search merely because one segment is.
    if (/\n|&&|\|\||;/.test(unwrapped))
        return "Bash";
    if (/^(?:rg|grep|ag|ack)\b/.test(unwrapped))
        return "Search";
    if (/^(?:ls|find|fd|tree)\b/.test(unwrapped))
        return "List";
    if (/^(?:cat|sed|head|tail|less|bat)\b/.test(unwrapped))
        return "Read";
    if (/^git\b/.test(unwrapped))
        return "Git";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check|typecheck)|pytest\b|cargo\s+test\b|go\s+test\b)/.test(unwrapped))
        return "Test";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)|tsc\b|cargo\s+build\b|go\s+build\b)/.test(unwrapped))
        return "Build";
    return "Bash";
}
function mcpArgs(configPath) {
    if (!configPath)
        return [];
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    const args = [];
    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name) || !server.url)
            continue;
        args.push("-c", `mcp_servers.${name}.url=${tomlString(server.url)}`);
        // A same-named server in the user's global Codex config may populate
        // headers from environment variables. Per-session static headers do not
        // replace that separate map during config merging, so explicitly clear it
        // or Codex can reject startup for an irrelevant missing variable.
        args.push("-c", `mcp_servers.${name}.env_http_headers={}`);
        if (server.headers && Object.keys(server.headers).length > 0) {
            const headers = Object.entries(server.headers)
                .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
                .join(",");
            args.push("-c", `mcp_servers.${name}.http_headers={${headers}}`);
        }
    }
    return args;
}
export function buildCodexArgs(opts) {
    const flags = [
        "--json",
        "--skip-git-repo-check",
        ...(opts.permissionMode === "plan"
            ? ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"']
            : ["--dangerously-bypass-approvals-and-sandbox"]),
        ...(opts.model ? ["--model", opts.model] : []),
        ...(opts.reasoningEffort ? ["-c", `model_reasoning_effort=${tomlString(opts.reasoningEffort)}`] : []),
        ...(opts.outcomeSchemaPath ? ["--output-schema", opts.outcomeSchemaPath] : []),
        ...mcpArgs(opts.mcpConfigPath),
    ];
    if (opts.resume) {
        if (!opts.backendSessionId)
            throw new Error("codex session cannot be resumed before its thread id is known");
        return ["exec", "resume", ...flags, opts.backendSessionId, "-"];
    }
    return ["exec", ...flags, "-"];
}
export function runCodex(opts) {
    const prompt = `${opts.systemPromptAppend}\n\n${opts.prompt}`;
    return spawnJsonAgent(opts.command, buildCodexArgs(opts), opts.cwd, createCodexEventNormalizer(opts), prompt);
}
export function createCodexEventNormalizer(opts, now = Date.now) {
    let lastMessage = "";
    const startedAt = now();
    const normalize = (event, emit) => {
        const sourceTimestamp = sourceTimestampMetadata(event);
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
            emit({ type: "system", subtype: "init", session_id: event.thread_id, ...(opts.model ? { model: opts.model } : {}), ...sourceTimestamp });
            return;
        }
        if (event.type === "item.completed") {
            const item = event.item;
            if (!item)
                return;
            if (item.type === "agent_message" && typeof item.text === "string") {
                lastMessage = item.text;
                // A schema-constrained final message is machine-readable outcome JSON;
                // the normalized result event below renders it as an outcome card.
                if (!opts.outcomeSchema) {
                    emit({ type: "assistant", message: { model: opts.model, content: [{ type: "text", text: item.text }] }, ...sourceTimestamp });
                }
            }
            else if (item.type === "command_execution") {
                const id = String(item.id ?? "command");
                const name = codexCommandToolName(item.command);
                const guarded = guardToolOutput(opts.sessionId, id, String(item.aggregated_output ?? ""));
                emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: { command: item.command } }] }, ...sourceTimestamp });
                emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: guarded.content }] }, ...sourceTimestamp });
                if (guarded.warning)
                    emit({ type: "warning", ...guarded.warning, ...sourceTimestamp });
            }
            else if (item.type === "file_change") {
                // apply_patch is a first-class Codex item, not a command_execution.
                // Keeping the structured changes makes edits visible in both live and
                // persisted transcripts instead of silently dropping them.
                const id = String(item.id ?? "file-change");
                const changes = normalizeCodexFileChanges(item, opts.cwd);
                // Render each affected file as its own Edit step. Keep the first ID for
                // compatibility and derive stable IDs for the remaining files.
                const editGroups = changes.length > 0 ? changes.map((change) => [change]) : [[]];
                for (let index = 0; index < editGroups.length; index++) {
                    emit({
                        type: "assistant",
                        message: { content: [{
                                    type: "tool_use", id: index === 0 ? id : `${id}:${index + 1}`, name: "Edit",
                                    input: {
                                        changes: editGroups[index],
                                        ...(item.status === "failed" && changes.length > 0 ? { partial: true } : {}),
                                    },
                                }] },
                        ...sourceTimestamp,
                    });
                }
                if (item.status === "failed") {
                    const error = item.error && typeof item.error === "object"
                        ? item.error.message
                        : item.error;
                    for (let index = 0; index < editGroups.length; index++) {
                        emit({
                            type: "user",
                            message: { content: [{
                                        type: "tool_result",
                                        tool_use_id: index === 0 ? id : `${id}:${index + 1}`,
                                        content: String(error ?? "File edit failed"),
                                    }] },
                            ...sourceTimestamp,
                        });
                    }
                }
            }
            else if (item.type === "mcp_tool_call") {
                const id = String(item.id ?? "mcp");
                const content = JSON.stringify(item.result ?? item.error ?? "");
                const guarded = guardToolOutput(opts.sessionId, id, content, "tool_output");
                emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: String(item.tool ?? "MCP"), input: item.arguments ?? {} }] }, ...sourceTimestamp });
                emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: guarded.content }] }, ...sourceTimestamp });
                if (guarded.warning)
                    emit({ type: "warning", ...guarded.warning, ...sourceTimestamp });
            }
            return;
        }
        if (event.type === "turn.completed") {
            const usage = event.usage ?? {};
            let structuredOutput;
            if (opts.outcomeSchema) {
                try {
                    structuredOutput = JSON.parse(lastMessage);
                }
                catch {
                    structuredOutput = undefined;
                }
            }
            emit({
                type: "result", subtype: "success", is_error: false, num_turns: 1,
                duration_ms: now() - startedAt,
                usage: {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_read_input_tokens: usage.cached_input_tokens,
                },
                result: lastMessage,
                ...(structuredOutput ? { structured_output: structuredOutput } : {}),
                ...(opts.model ? { model: opts.model } : {}),
                ...sourceTimestamp,
            });
            return;
        }
        if (event.type === "turn.failed" || event.type === "error") {
            const error = event.error;
            emit({ type: "result", subtype: "error", is_error: true, errors: [String(error?.message ?? event.message ?? "Codex run failed")], ...sourceTimestamp });
        }
    };
    return normalize;
}
