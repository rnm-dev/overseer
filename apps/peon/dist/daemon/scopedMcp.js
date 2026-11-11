import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { ProjectServiceError } from "./projects/index.js";
import { MAX_SESSION_SPAWN_NAME_LENGTH, MAX_SESSION_SPAWN_PROMPT_LENGTH, MAX_SESSION_WAIT_MS, DEFAULT_CHILD_TRANSCRIPT_CHARS, DEFAULT_CHILD_TRANSCRIPT_LIMIT, MAX_CHILD_TRANSCRIPT_CHARS, MAX_CHILD_TRANSCRIPT_LIMIT, MIN_CHILD_TRANSCRIPT_CHARS, SessionSpawnError, } from "./sessions/index.js";
import { SESSION_MCP_HEADER, verifySessionMcpCredential } from "./sessionMcpAuth.js";
import { LIMITS as SIGNOFF_LIMITS, SignoffError } from "./signoffs/index.js";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function createScopedMcpRouter(options) {
    const router = express.Router();
    router.use((req, res, next) => {
        if (!requestIsLocal(req))
            return res.status(403).json({ error: "MCP is available on loopback only" });
        next();
    });
    router.use("/armory/:bindingId", (req, res, next) => {
        const sessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
        if (!sessionId)
            return res.status(401).json({ error: "invalid Armory turn capability" });
        res.locals.armorySessionId = sessionId;
        next();
    }, createProviderRouter((req) => armoryProvider(options.armoryRuntime, String(req.params.bindingId), String(req.res?.locals.armorySessionId ?? ""))));
    if (options.projectService) {
        router.use("/projects", createProviderRouter(() => projectProvider(options.projectService)));
    }
    if (options.requestManagedPluginInstall) {
        router.use("/plugins", (req, res, next) => {
            const sessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
            if (!sessionId)
                return res.status(401).json({ error: "invalid session MCP capability" });
            res.locals.parentSessionId = sessionId;
            next();
        }, createProviderRouter((req) => managedPluginProvider(options.requestManagedPluginInstall, String(req.res?.locals.parentSessionId ?? ""))));
    }
    if (options.signoffs) {
        router.use("/signoffs", (req, res, next) => {
            const sessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
            if (!sessionId)
                return res.status(401).json({ error: "invalid session MCP capability" });
            res.locals.signoffSessionId = sessionId;
            next();
        }, createProviderRouter((req) => signoffProvider(options.signoffs, String(req.res?.locals.signoffSessionId ?? ""))));
    }
    if (options.sessionOrchestration) {
        router.use("/sessions", (req, res, next) => {
            const parentSessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
            if (!parentSessionId)
                return res.status(401).json({ error: "invalid session MCP capability" });
            res.locals.parentSessionId = parentSessionId;
            next();
        }, createProviderRouter((req) => sessionProvider(options.sessionOrchestration, String(req.res?.locals.parentSessionId ?? ""))));
    }
    return router;
}
const MANAGED_PLUGIN_TOOLS = [{
        name: "request_plugin_install",
        description: "Request explicit operator approval to install a managed Codex plugin. The call waits for the operator's Install or Decline response. Use it when a requested plugin is unavailable, and do not claim an installation was requested without calling it.",
        inputSchema: {
            type: "object",
            properties: {
                plugin_id: { type: "string", enum: ["posthog@openai-curated-remote"] },
            },
            required: ["plugin_id"],
            additionalProperties: false,
        },
    }];
function managedPluginProvider(requestInstall, sessionId) {
    return {
        listTools: async () => MANAGED_PLUGIN_TOOLS,
        callTool: async (name, args) => {
            if (name !== "request_plugin_install")
                return toolError(`unknown tool: ${name}`);
            const pluginId = requiredString(args.plugin_id, "plugin_id");
            const response = await requestInstall(sessionId, pluginId);
            const text = response.contentItems?.filter((item) => item.type === "inputText" && typeof item.text === "string")
                .map((item) => item.text).join("\n") || "Managed plugin request completed.";
            return { content: [{ type: "text", text }], isError: response.success !== true };
        },
    };
}
const SNAPSHOT_PROPERTIES = {
    title: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.title },
    summary: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.summary, description: "What is being decided and why it needs a person." },
    options: {
        type: "array",
        minItems: 1,
        maxItems: SIGNOFF_LIMITS.options,
        description: "Each option is a complete plan you would carry out and defend. No \"do nothing\" option: rejecting is always possible.",
        items: {
            type: "object",
            properties: {
                id: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.id },
                label: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.label },
                recommended: { type: "boolean" },
                rationale: { type: "string", maxLength: SIGNOFF_LIMITS.rationale },
                actions: {
                    type: "array",
                    minItems: 1,
                    maxItems: SIGNOFF_LIMITS.actionsPerOption,
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.id },
                            summary: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.actionSummary },
                            detail: { type: "string", maxLength: SIGNOFF_LIMITS.actionDetail, description: "Exact outgoing text or value wherever something leaves this machine." },
                            type: { type: "string", enum: ["freeform"] },
                        },
                        required: ["id", "summary"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["id", "label", "actions"],
            additionalProperties: false,
        },
    },
    assignees: { type: "array", maxItems: SIGNOFF_LIMITS.assignees, items: { type: "string", minLength: 1 }, description: "Who should decide; empty means project administrators and workspace owners." },
    context: { type: "array", maxItems: SIGNOFF_LIMITS.contextExcerpts, items: { type: "string", maxLength: SIGNOFF_LIMITS.contextExcerpt }, description: "Short excerpts from the triggering event, never whole payloads." },
};
const signoffIdSchema = { type: "string", minLength: 1 };
const SIGNOFF_PROPOSE_TOOL = {
    name: "signoff_propose",
    description: "Record a sign-off: a decision a person must make before you take a step. Do not wait for it: after proposing, do everything else you can without the decision and end your turn. The decision arrives later as a follow-up in this session. One sign-off per topic, with all its actions inside.",
    inputSchema: { type: "object", properties: SNAPSHOT_PROPERTIES, required: ["title", "summary", "options"], additionalProperties: false },
};
const SIGNOFF_TOOLS = [
    {
        name: "signoff_list",
        description: "List this session's sign-offs with their status and head seq.",
        inputSchema: { type: "object", properties: { status: { type: "string" } }, additionalProperties: false },
    },
    {
        name: "signoff_get",
        description: "Read one of this session's sign-offs: the current snapshot and the full history.",
        inputSchema: { type: "object", properties: { signoffId: signoffIdSchema }, required: ["signoffId"], additionalProperties: false },
    },
    {
        name: "signoff_revise",
        description: "Replace the proposal after a comment (or when facts changed). The message says what changed and why. Not allowed while executing or after it ended.",
        inputSchema: {
            type: "object",
            properties: {
                signoffId: signoffIdSchema,
                message: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.message },
                snapshot: { type: "object", properties: SNAPSHOT_PROPERTIES, required: ["title", "summary", "options"], additionalProperties: false },
            },
            required: ["signoffId", "message", "snapshot"],
            additionalProperties: false,
        },
    },
    {
        name: "signoff_answer",
        description: "Reply to a comment without changing the proposal.",
        inputSchema: {
            type: "object",
            properties: { signoffId: signoffIdSchema, message: { type: "string", minLength: 1, maxLength: SIGNOFF_LIMITS.message } },
            required: ["signoffId", "message"],
            additionalProperties: false,
        },
    },
    {
        name: "signoff_withdraw",
        description: "Withdraw a sign-off that is obsolete or handled elsewhere. Pass supersededBy to mark it merged into another sign-off of this session.",
        inputSchema: {
            type: "object",
            properties: {
                signoffId: signoffIdSchema,
                message: { type: "string", maxLength: SIGNOFF_LIMITS.message },
                supersededBy: signoffIdSchema,
            },
            required: ["signoffId"],
            additionalProperties: false,
        },
    },
    {
        name: "signoff_executing",
        description: "Lock an approved sign-off before acting on it. baseSeq is the seq the approval was made against (given in the approval follow-up).",
        inputSchema: {
            type: "object",
            properties: { signoffId: signoffIdSchema, baseSeq: { type: "integer", minimum: 1 } },
            required: ["signoffId", "baseSeq"],
            additionalProperties: false,
        },
    },
    {
        name: "signoff_executed",
        description: "Record the outcome after acting: one result per action of the approved option. Requires a prior signoff_executing. Nothing can change afterwards.",
        inputSchema: {
            type: "object",
            properties: {
                signoffId: signoffIdSchema,
                baseSeq: { type: "integer", minimum: 1 },
                message: { type: "string", maxLength: SIGNOFF_LIMITS.message },
                results: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            actionId: { type: "string", minLength: 1 },
                            outcome: { type: "string", enum: ["done", "failed", "skipped"] },
                            note: { type: "string", maxLength: SIGNOFF_LIMITS.resultNote },
                        },
                        required: ["actionId", "outcome"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["signoffId", "baseSeq", "results"],
            additionalProperties: false,
        },
    },
];
function signoffProvider(api, sessionId) {
    return {
        listTools: async () => api.origin(sessionId) === "trigger" ? [SIGNOFF_PROPOSE_TOOL, ...SIGNOFF_TOOLS] : SIGNOFF_TOOLS,
        callTool: async (name, args) => {
            try {
                const { service } = api;
                if (name === "signoff_propose") {
                    // Refused here too, not only hidden from the list: the rule cannot
                    // depend on the agent not knowing the tool's name.
                    if (api.origin(sessionId) !== "trigger") {
                        return toolError("SIGNOFF_NOT_ALLOWED: sign-offs are only for sessions started by a trigger. A person is in this chat: ask them directly.");
                    }
                    return toolJson(service.propose(sessionId, args));
                }
                if (name === "signoff_list")
                    return toolJson(service.agentList(sessionId, args));
                if (name === "signoff_get")
                    return toolJson(service.agentGet(sessionId, args));
                if (name === "signoff_revise")
                    return toolJson(service.revise(sessionId, args));
                if (name === "signoff_answer")
                    return toolJson(service.answer(sessionId, args));
                if (name === "signoff_withdraw")
                    return toolJson(service.withdraw(sessionId, args));
                if (name === "signoff_executing")
                    return toolJson(service.executing(sessionId, args));
                if (name === "signoff_executed")
                    return toolJson(service.executed(sessionId, args));
                return toolError(`unknown tool: ${name}`);
            }
            catch (error) {
                return toolError(error instanceof SignoffError ? `${error.code}: ${error.message}` : safeMessage(error));
            }
        },
    };
}
function createProviderRouter(resolveProvider) {
    const router = express.Router({ mergeParams: true });
    router.post("/", async (req, res) => {
        const server = new Server({ name: "peon-scoped-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: await resolveProvider(req).listTools(),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const args = request.params.arguments ?? {};
            return resolveProvider(req).callTool(request.params.name, args, extra.signal);
        });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error("scoped MCP request failed:", safeMessage(error));
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: safeMessage(error) }, id: null });
            }
        }
        finally {
            await transport.close().catch(() => undefined);
            await server.close().catch(() => undefined);
        }
    });
    router.get("/", (_req, res) => methodNotAllowed(res));
    router.delete("/", (_req, res) => methodNotAllowed(res));
    return router;
}
function armoryProvider(runtime, bindingId, sessionId) {
    return {
        listTools: () => runtime.listTools(bindingId, sessionId),
        callTool: (name, args, signal) => runtime.callTool(bindingId, sessionId, name, args, signal),
    };
}
const QUICK_LINK_TOOLS = [
    {
        name: "list_project_quick_links",
        description: "List the saved quick links for a Peon project in stable display order.",
        inputSchema: projectKeySchema(),
    },
    {
        name: "create_project_quick_link",
        description: "Append a saved quick link to a Peon project.",
        inputSchema: {
            type: "object",
            properties: {
                projectKey: { type: "string", minLength: 1 },
                title: { type: "string", minLength: 1, maxLength: 120 },
                url: { type: "string", minLength: 1, maxLength: 2048 },
            },
            required: ["projectKey", "title", "url"],
            additionalProperties: false,
        },
    },
    {
        name: "update_project_quick_link",
        description: "Update the title and/or URL of a saved project quick link without changing its ID or order.",
        inputSchema: {
            type: "object",
            properties: {
                projectKey: { type: "string", minLength: 1 },
                id: { type: "string", minLength: 1 },
                title: { type: "string", minLength: 1, maxLength: 120 },
                url: { type: "string", minLength: 1, maxLength: 2048 },
            },
            required: ["projectKey", "id"],
            additionalProperties: false,
        },
    },
    {
        name: "delete_project_quick_link",
        description: "Delete one saved quick link from a Peon project.",
        inputSchema: {
            type: "object",
            properties: {
                projectKey: { type: "string", minLength: 1 },
                id: { type: "string", minLength: 1 },
            },
            required: ["projectKey", "id"],
            additionalProperties: false,
        },
    },
];
function projectKeySchema() {
    return {
        type: "object",
        properties: { projectKey: { type: "string", minLength: 1 } },
        required: ["projectKey"],
        additionalProperties: false,
    };
}
function projectProvider(service) {
    return {
        listTools: async () => QUICK_LINK_TOOLS,
        callTool: async (name, args) => {
            try {
                const projectKey = requiredString(args.projectKey, "projectKey");
                if (name === "list_project_quick_links") {
                    return toolJson(service.listQuickLinks(projectKey));
                }
                if (name === "create_project_quick_link") {
                    return toolJson(service.createQuickLink(projectKey, args));
                }
                const id = requiredString(args.id, "id");
                if (name === "update_project_quick_link") {
                    return toolJson(service.updateQuickLink(projectKey, id, args));
                }
                if (name === "delete_project_quick_link") {
                    service.removeQuickLink(projectKey, id);
                    return toolJson({ ok: true });
                }
                return toolError(`unknown tool: ${name}`);
            }
            catch (error) {
                return toolError(error instanceof ProjectServiceError ? `${error.kind}: ${error.message}` : safeMessage(error));
            }
        },
    };
}
const SESSION_TOOLS = [
    {
        name: "list_session_options",
        description: "List selectable Peon projects, available agents/models/reasoning efforts, and the hard recursion-depth limit.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "spawn_sessions",
        description: "Create durable, user-visible Peon child sessions without a count cap. Use this whenever the user asks to create, start, or delegate work to another session, including when they choose a model or reasoning effort; do not substitute provider-native sub-agents. Each prompt must be self-contained. Children cannot spawn sessions. The initial child turn and every later turn initiated with send_session_followup each enqueue one hidden completion trigger into this parent's next turn.",
        inputSchema: {
            type: "object",
            properties: {
                sessions: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            requestId: {
                                type: "string",
                                minLength: 1,
                                maxLength: 128,
                                description: "Stable parent-scoped idempotency key. Reuse it when retrying the exact same child.",
                            },
                            name: {
                                type: "string",
                                minLength: 1,
                                maxLength: MAX_SESSION_SPAWN_NAME_LENGTH,
                                description: "Optional short display name shown as the child session title.",
                            },
                            prompt: {
                                type: "string",
                                minLength: 1,
                                maxLength: MAX_SESSION_SPAWN_PROMPT_LENGTH,
                                description: "Self-contained task. Parent transcript is not copied into the child.",
                            },
                            projectKey: { type: "string", minLength: 1 },
                            agent: { type: "string", minLength: 1 },
                            model: { type: "string", minLength: 1 },
                            reasoningEffort: { type: "string", minLength: 1 },
                        },
                        required: ["requestId", "prompt", "projectKey", "agent"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["sessions"],
            additionalProperties: false,
        },
    },
    {
        name: "get_child_sessions",
        description: "Return compact status and outcome records for this session's direct children.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "wait_for_child_sessions",
        description: `Wait up to ${MAX_SESSION_WAIT_MS} ms for selected direct children, returning compact outcomes without loading transcripts.`,
        inputSchema: {
            type: "object",
            properties: {
                sessionIds: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
                timeoutMs: { type: "integer", minimum: 0, maximum: MAX_SESSION_WAIT_MS, default: MAX_SESSION_WAIT_MS },
            },
            additionalProperties: false,
        },
    },
    {
        name: "get_child_transcript",
        description: `Read one bounded newest-to-older transcript page for a direct child. Defaults to ${DEFAULT_CHILD_TRANSCRIPT_LIMIT} events and ${DEFAULT_CHILD_TRANSCRIPT_CHARS} serialized characters; oversized events become truncated previews or metadata markers.`,
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: MAX_CHILD_TRANSCRIPT_LIMIT,
                    default: DEFAULT_CHILD_TRANSCRIPT_LIMIT,
                },
                maxChars: {
                    type: "integer",
                    minimum: MIN_CHILD_TRANSCRIPT_CHARS,
                    maximum: MAX_CHILD_TRANSCRIPT_CHARS,
                    default: DEFAULT_CHILD_TRANSCRIPT_CHARS,
                },
                cursor: {
                    type: "string",
                    minLength: 1,
                    description: "Opaque nextCursor from the previous page.",
                },
            },
            required: ["sessionId"],
            additionalProperties: false,
        },
    },
    {
        name: "send_session_followup",
        description: "Send a follow-up to any existing Peon session, including the caller. There is no count cap. A running target may be steered or interrupted according to normal Peon follow-up semantics. When the target is this caller's child, completion enqueues a new hidden trigger for the caller.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string", minLength: 1 },
                prompt: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningEffort: { type: "string", minLength: 1 },
                requestId: {
                    type: "string",
                    minLength: 1,
                    maxLength: 128,
                    description: "Optional caller correlation id recorded on the target user-message event.",
                },
            },
            required: ["sessionId", "prompt"],
            additionalProperties: false,
        },
    },
];
function sessionProvider(service, parentSessionId) {
    return {
        listTools: async () => SESSION_TOOLS,
        callTool: async (name, args, signal) => {
            try {
                if (name === "list_session_options")
                    return toolJson(service.listOptions(parentSessionId));
                if (name === "spawn_sessions")
                    return toolJson(service.spawn(parentSessionId, args));
                if (name === "get_child_sessions")
                    return toolJson(service.children(parentSessionId));
                if (name === "wait_for_child_sessions")
                    return toolJson(await service.wait(parentSessionId, args, signal));
                if (name === "get_child_transcript")
                    return toolJson(await service.transcript(parentSessionId, args));
                if (name === "send_session_followup")
                    return toolJson(service.followUp(parentSessionId, args));
                return toolError(`unknown tool: ${name}`);
            }
            catch (error) {
                return toolError(error instanceof SessionSpawnError ? `${error.code}: ${error.message}` : safeMessage(error));
            }
        },
    };
}
function requiredString(value, field) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${field} is required`);
    return value.trim();
}
function toolJson(value) {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function toolError(message) {
    return { isError: true, content: [{ type: "text", text: message }] };
}
function requestIsLocal(req) {
    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? ""))
        return false;
    if (req.headers.origin)
        return false;
    const host = req.headers.host?.replace(/:\d+$/, "") ?? "";
    return LOOPBACK_HOSTS.has(host);
}
function methodNotAllowed(res) {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}
function safeMessage(error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
