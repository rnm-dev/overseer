import { SESSION_MCP_HEADER, sessionMcpCredential } from "./sessionMcpAuth.js";
function serverName(value) {
    return value.replaceAll("-", "_");
}
/** Tracks the Armory MCP endpoints that are currently healthy and enabled. */
export class McpBindingRegistry {
    armoryPackages = new Set();
    exposeArmoryPackage(packageId) {
        this.armoryPackages.add(packageId);
    }
    hideArmoryPackage(packageId) {
        this.armoryPackages.delete(packageId);
    }
    armoryPackageIds() {
        return [...this.armoryPackages].sort();
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
        if (context?.allowSessionSpawning) {
            bindings.push(this.localBinding("peon_sessions", "/mcp/sessions", {
                [SESSION_MCP_HEADER]: sessionMcpCredential(context.sessionId),
            }));
        }
        for (const packageId of this.registry.armoryPackageIds()) {
            const name = `armory_${serverName(packageId)}`;
            bindings.push(this.localBinding(name, `/mcp/armory/${encodeURIComponent(packageId)}`));
        }
        return {
            mcpServers: Object.fromEntries(bindings.map((binding) => [binding.name, binding.config])),
            allowedTools: bindings.map((binding) => binding.allowedTools).join(","),
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
