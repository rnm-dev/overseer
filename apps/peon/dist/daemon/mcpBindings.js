import { SESSION_MCP_HEADER, sessionMcpCredential } from "./sessionMcpAuth.js";
function serverName(value) {
    return value.replaceAll("-", "_");
}
/** Connects per-turn MCP assembly to the assignment-scoped Armory runtime. */
export class McpBindingRegistry {
    armoryProvider = null;
    registerArmoryProvider(provider) {
        this.armoryProvider = provider;
    }
    snapshotArmoryTurn(context) {
        return this.armoryProvider?.snapshotTurn(context);
    }
}
/** Builds the complete, scoped MCP configuration for one agent turn. */
export class McpConfigAssembler {
    registry;
    controlBaseUrl;
    constructor(registry, controlBaseUrl) {
        this.registry = registry;
        this.controlBaseUrl = controlBaseUrl;
    }
    assemble(context) {
        const bindings = [
            this.localBinding("peon_projects", "/mcp/projects"),
        ];
        if (context) {
            bindings.push(this.localBinding("peon_plugins", "/mcp/plugins", {
                [SESSION_MCP_HEADER]: sessionMcpCredential(context.sessionId),
            }));
        }
        if (context?.allowSessionSpawning) {
            bindings.push(this.localBinding("peon_sessions", "/mcp/sessions", {
                [SESSION_MCP_HEADER]: sessionMcpCredential(context.sessionId),
            }));
        }
        const armoryLease = context?.projectId && context.turnId
            ? this.registry.snapshotArmoryTurn({ sessionId: context.sessionId, turnId: context.turnId, projectId: context.projectId, workflowExecution: context.workflowExecution })
            : undefined;
        for (const binding of armoryLease?.bindings ?? []) {
            const name = `armory_${serverName(binding.packageId)}`;
            bindings.push(this.localBinding(name, `/mcp/armory/${encodeURIComponent(binding.bindingId)}`, {
                [SESSION_MCP_HEADER]: sessionMcpCredential(context.sessionId),
            }));
        }
        return {
            mcpServers: Object.fromEntries(bindings.map((binding) => [binding.name, binding.config])),
            allowedTools: bindings.map((binding) => binding.allowedTools).join(","),
            ...(armoryLease?.unavailable?.length ? { unavailableArmoryPackages: armoryLease.unavailable } : {}),
            ...(armoryLease ? { release: () => armoryLease.release() } : {}),
        };
    }
    localBinding(name, route, headers = {}) {
        return {
            name,
            config: { type: "http", url: `${this.controlBaseUrl}${route}`, headers },
            allowedTools: `mcp__${name}__*`,
        };
    }
}
export const mcpBindingRegistry = new McpBindingRegistry();
