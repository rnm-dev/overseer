import { SESSION_MCP_HEADER, sessionMcpCredential } from "./sessionMcpAuth.js";

export interface McpHttpBinding {
  name: string;
  config: {
    type: "http";
    url: string;
    headers: Record<string, string>;
  };
  allowedTools: string;
}

export interface AssembledMcpConfig {
  mcpServers: Record<string, McpHttpBinding["config"]>;
  allowedTools: string;
}

function serverName(value: string): string {
  return value.replaceAll("-", "_");
}

/** Tracks the Armory MCP endpoints that are currently healthy and enabled. */
export class McpBindingRegistry {
  private readonly armoryPackages = new Set<string>();

  exposeArmoryPackage(packageId: string): void {
    this.armoryPackages.add(packageId);
  }

  hideArmoryPackage(packageId: string): void {
    this.armoryPackages.delete(packageId);
  }

  armoryPackageIds(): string[] {
    return [...this.armoryPackages].sort();
  }
}

/** Builds the complete, scoped MCP configuration for one agent turn. */
export class McpConfigAssembler {
  constructor(
    private readonly registry: McpBindingRegistry,
    private readonly controlBaseUrl: string,
  ) {}

  assemble(context?: { sessionId: string; allowSessionSpawning: boolean }): AssembledMcpConfig | undefined {
    const bindings: McpHttpBinding[] = [
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

    for (const packageId of this.registry.armoryPackageIds()) {
      const name = `armory_${serverName(packageId)}`;
      bindings.push(this.localBinding(name, `/mcp/armory/${encodeURIComponent(packageId)}`));
    }

    return {
      mcpServers: Object.fromEntries(bindings.map((binding) => [binding.name, binding.config])),
      allowedTools: bindings.map((binding) => binding.allowedTools).join(","),
    };
  }

  private localBinding(name: string, route: string, headers: Record<string, string> = {}): McpHttpBinding {
    return {
      name,
      config: { type: "http", url: `${this.controlBaseUrl}${route}`, headers },
      allowedTools: `mcp__${name}__*`,
    };
  }
}

export const mcpBindingRegistry = new McpBindingRegistry();
