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
  unavailableArmoryPackages?: ArmoryTurnUnavailable[];
  release?: () => void;
}

export interface ArmoryTurnContext {
  sessionId: string;
  turnId: string;
  projectId: string;
  workflowExecution?: { packageId: string; executionId: string; leaseToken: string } | null;
}

export interface ArmoryTurnBinding {
  packageId: string;
  bindingId: string;
}

export interface ArmoryTurnUnavailable {
  packageId: string | null;
  code: string;
  message: string;
}

export interface ArmoryTurnBindingLease {
  bindings: ArmoryTurnBinding[];
  unavailable?: ArmoryTurnUnavailable[];
  release(): void;
}

export interface ArmoryTurnBindingProvider {
  snapshotTurn(context: ArmoryTurnContext): ArmoryTurnBindingLease;
}

function serverName(value: string): string {
  return value.replaceAll("-", "_");
}

/** Connects per-turn MCP assembly to the assignment-scoped Armory runtime. */
export class McpBindingRegistry {
  private armoryProvider: ArmoryTurnBindingProvider | null = null;

  registerArmoryProvider(provider: ArmoryTurnBindingProvider): void {
    this.armoryProvider = provider;
  }

  snapshotArmoryTurn(context: ArmoryTurnContext): ArmoryTurnBindingLease | undefined {
    return this.armoryProvider?.snapshotTurn(context);
  }
}

/** Builds the complete, scoped MCP configuration for one agent turn. */
export class McpConfigAssembler {
  constructor(
    private readonly registry: McpBindingRegistry,
    private readonly controlBaseUrl: string,
  ) {}

  assemble(context?: { sessionId: string; turnId?: string; projectId?: string | null; allowSessionSpawning: boolean; workflowExecution?: ArmoryTurnContext["workflowExecution"] }): AssembledMcpConfig | undefined {
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

    const armoryLease = context?.projectId && context.turnId
      ? this.registry.snapshotArmoryTurn({ sessionId: context.sessionId, turnId: context.turnId, projectId: context.projectId, workflowExecution: context.workflowExecution })
      : undefined;
    for (const binding of armoryLease?.bindings ?? []) {
      const name = `armory_${serverName(binding.packageId)}`;
      bindings.push(this.localBinding(name, `/mcp/armory/${encodeURIComponent(binding.bindingId)}`, {
        [SESSION_MCP_HEADER]: sessionMcpCredential(context!.sessionId),
      }));
    }

    return {
      mcpServers: Object.fromEntries(bindings.map((binding) => [binding.name, binding.config])),
      allowedTools: bindings.map((binding) => binding.allowedTools).join(","),
      ...(armoryLease?.unavailable?.length ? { unavailableArmoryPackages: armoryLease.unavailable } : {}),
      ...(armoryLease ? { release: () => armoryLease.release() } : {}),
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
