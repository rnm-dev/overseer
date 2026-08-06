import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ArmoryMcpRuntime } from "./armory/index.js";
import { ProjectServiceError, type ProjectQuickLink, type ProjectService } from "./projects/index.js";
import {
  MAX_SESSION_SPAWN_NAME_LENGTH,
  MAX_SESSION_SPAWN_PROMPT_LENGTH,
  MAX_SESSION_WAIT_MS,
  DEFAULT_CHILD_TRANSCRIPT_CHARS,
  DEFAULT_CHILD_TRANSCRIPT_LIMIT,
  MAX_CHILD_TRANSCRIPT_CHARS,
  MAX_CHILD_TRANSCRIPT_LIMIT,
  MIN_CHILD_TRANSCRIPT_CHARS,
  SessionSpawnError,
  type SessionOrchestrationService,
} from "./sessions/index.js";
import { SESSION_MCP_HEADER, verifySessionMcpCredential } from "./sessionMcpAuth.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface McpToolProvider {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
}

type ManagedPluginInstallRequester = (sessionId: string, pluginId: string) => Promise<unknown>;

type SessionOrchestrationApi = Pick<
  SessionOrchestrationService,
  "listOptions" | "spawn" | "children" | "wait" | "transcript" | "followUp"
>;

export function createScopedMcpRouter(options: {
  armoryRuntime: ArmoryMcpRuntime;
  projectService?: ProjectService;
  sessionOrchestration?: SessionOrchestrationApi;
  requestManagedPluginInstall?: ManagedPluginInstallRequester;
}): express.Router {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!requestIsLocal(req)) return res.status(403).json({ error: "MCP is available on loopback only" });
    next();
  });

  router.use("/armory/:bindingId", (req, res, next) => {
    const sessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
    if (!sessionId) return res.status(401).json({ error: "invalid Armory turn capability" });
    res.locals.armorySessionId = sessionId;
    next();
  }, createProviderRouter((req) => armoryProvider(
    options.armoryRuntime,
    String(req.params.bindingId),
    String(req.res?.locals.armorySessionId ?? ""),
  )));
  if (options.projectService) {
    router.use("/projects", createProviderRouter(() => projectProvider(options.projectService!)));
  }
  if (options.requestManagedPluginInstall) {
    router.use("/plugins", (req, res, next) => {
      const sessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
      if (!sessionId) return res.status(401).json({ error: "invalid session MCP capability" });
      res.locals.parentSessionId = sessionId;
      next();
    }, createProviderRouter((req) => managedPluginProvider(
      options.requestManagedPluginInstall!,
      String(req.res?.locals.parentSessionId ?? ""),
    )));
  }
  if (options.sessionOrchestration) {
    router.use("/sessions", (req, res, next) => {
      const parentSessionId = verifySessionMcpCredential(req.headers[SESSION_MCP_HEADER]);
      if (!parentSessionId) return res.status(401).json({ error: "invalid session MCP capability" });
      res.locals.parentSessionId = parentSessionId;
      next();
    }, createProviderRouter((req) => sessionProvider(
      options.sessionOrchestration!,
      String(req.res?.locals.parentSessionId ?? ""),
    )));
  }
  return router;
}

const MANAGED_PLUGIN_TOOLS: Tool[] = [{
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

function managedPluginProvider(requestInstall: ManagedPluginInstallRequester, sessionId: string): McpToolProvider {
  return {
    listTools: async () => MANAGED_PLUGIN_TOOLS,
    callTool: async (name, args) => {
      if (name !== "request_plugin_install") return toolError(`unknown tool: ${name}`);
      const pluginId = requiredString(args.plugin_id, "plugin_id");
      const response = await requestInstall(sessionId, pluginId) as { contentItems?: Array<{ type?: string; text?: string }>; success?: boolean };
      const text = response.contentItems?.filter((item) => item.type === "inputText" && typeof item.text === "string")
        .map((item) => item.text).join("\n") || "Managed plugin request completed.";
      return { content: [{ type: "text", text }], isError: response.success !== true };
    },
  };
}

function createProviderRouter(resolveProvider: (req: express.Request) => McpToolProvider): express.Router {
  const router = express.Router({ mergeParams: true });

  router.post("/", async (req, res) => {
    const server = new Server(
      { name: "peon-scoped-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
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
    } catch (error) {
      console.error("scoped MCP request failed:", safeMessage(error));
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: safeMessage(error) }, id: null });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  router.get("/", (_req, res) => methodNotAllowed(res));
  router.delete("/", (_req, res) => methodNotAllowed(res));
  return router;
}

function armoryProvider(runtime: ArmoryMcpRuntime, bindingId: string, sessionId: string): McpToolProvider {
  return {
    listTools: () => runtime.listTools(bindingId, sessionId),
    callTool: (name, args, signal) => runtime.callTool(bindingId, sessionId, name, args, signal),
  };
}

const QUICK_LINK_TOOLS: Tool[] = [
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

function projectKeySchema(): Tool["inputSchema"] {
  return {
    type: "object",
    properties: { projectKey: { type: "string", minLength: 1 } },
    required: ["projectKey"],
    additionalProperties: false,
  };
}

function projectProvider(service: ProjectService): McpToolProvider {
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
      } catch (error) {
        return toolError(error instanceof ProjectServiceError ? `${error.kind}: ${error.message}` : safeMessage(error));
      }
    },
  };
}

const SESSION_TOOLS: Tool[] = [
  {
    name: "list_session_options",
    description: "List selectable Peon projects, available agents/models/reasoning efforts, and the hard recursion-depth limit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "spawn_sessions",
    description: "Start independent child sessions without a count cap. Each prompt must be self-contained. Children cannot spawn sessions. The initial child turn and every later turn initiated with send_session_followup each enqueue one hidden completion trigger into this parent's next turn.",
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

function sessionProvider(service: SessionOrchestrationApi, parentSessionId: string): McpToolProvider {
  return {
    listTools: async () => SESSION_TOOLS,
    callTool: async (name, args, signal) => {
      try {
        if (name === "list_session_options") return toolJson(service.listOptions(parentSessionId));
        if (name === "spawn_sessions") return toolJson(service.spawn(parentSessionId, args));
        if (name === "get_child_sessions") return toolJson(service.children(parentSessionId));
        if (name === "wait_for_child_sessions") return toolJson(await service.wait(parentSessionId, args, signal));
        if (name === "get_child_transcript") return toolJson(await service.transcript(parentSessionId, args));
        if (name === "send_session_followup") return toolJson(service.followUp(parentSessionId, args));
        return toolError(`unknown tool: ${name}`);
      } catch (error) {
        return toolError(error instanceof SessionSpawnError ? `${error.code}: ${error.message}` : safeMessage(error));
      }
    },
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function requestIsLocal(req: express.Request): boolean {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) return false;
  if (req.headers.origin) return false;
  const host = req.headers.host?.replace(/:\d+$/, "") ?? "";
  return LOOPBACK_HOSTS.has(host);
}

function methodNotAllowed(res: express.Response): void {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
