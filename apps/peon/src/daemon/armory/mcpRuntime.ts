import { lstat, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_STARTUP_MS,
  MAX_TOOL_CALL_MS,
  parseArmoryManifest,
  type ArmoryCommand,
  type ArmoryManifest,
} from "./contracts.js";
import { getArmoryActivation } from "./installer.js";
import { ArmoryOperationError, ArmoryOperationCoordinator } from "./operationCoordinator.js";
import { packageVersionPath, resolveContainedPath } from "./paths.js";
import type { ArmoryPackageRuntimeController } from "./configuration.js";
import { createArmoryRedactor } from "./redaction.js";
import { ARMORY_COMMAND_PATH } from "./runtimeEnvironment.js";
import type { ArmoryStores } from "./stores.js";
import { mcpBindingRegistry, type McpBindingRegistry } from "../mcpBindings.js";

interface RunningPackage {
  client: Client;
  transport: StdioClientTransport;
  manifest: ArmoryManifest;
  tools: Tool[];
}

export interface ArmoryMcpRetryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MCP_RETRY_INITIAL_MS = 1_000;
const DEFAULT_MCP_RETRY_MAX_MS = 60_000;
const MAX_MCP_STARTUP_STDERR_BYTES = 16 * 1024;

/** Owns the stdio MCP child for every enabled Armory package. */
export class ArmoryMcpRuntime implements ArmoryPackageRuntimeController {
  private readonly running = new Map<string, RunningPackage>();
  private readonly starting = new Map<string, Promise<RunningPackage>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly activeCalls = new Map<string, Set<Promise<unknown>>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private closed = false;

  constructor(
    readonly stores: ArmoryStores,
    private readonly bindings: McpBindingRegistry = mcpBindingRegistry,
    retry: ArmoryMcpRetryOptions = {},
  ) {
    const initial = Number.isFinite(retry.initialDelayMs) ? Math.floor(retry.initialDelayMs!) : DEFAULT_MCP_RETRY_INITIAL_MS;
    const maximum = Number.isFinite(retry.maxDelayMs) ? Math.floor(retry.maxDelayMs!) : DEFAULT_MCP_RETRY_MAX_MS;
    this.retryInitialMs = Math.max(1, initial);
    this.retryMaxMs = Math.max(this.retryInitialMs, maximum);
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    const installed = await this.stores.installed.list();
    const enabled = new Set(installed.filter((record) => record.enabled).map((record) => record.id));
    for (const id of this.retryTimers.keys()) if (!enabled.has(id)) this.cancelRetry(id);
    await Promise.all([...this.running.keys()].filter((id) => !enabled.has(id)).map((id) => this.stop(id)));
    for (const record of installed) {
      if (!record.enabled) continue;
      try {
        await this.start(record.id);
      } catch (error) {
        await this.markUnavailable(record.id, error).catch((storeError) => this.reportBackgroundError(record.id, storeError));
        if (isRetryableStartupError(error)) this.scheduleRetry(record.id);
        continue;
      }
      await this.markAvailable(record.id).catch((error) => this.reportBackgroundError(record.id, error));
    }
  }

  async healthCheck(packageId: string): Promise<void> {
    if (this.running.has(packageId)) {
      await this.refreshTools(packageId);
      return;
    }
    const loaded = await this.loadPackage(packageId, false);
    if (!loaded.manifest.mcp) return;
    const temporary = await this.connectPackage(loaded.manifest, loaded.packageDir);
    await temporary.client.close().catch(() => undefined);
  }

  async start(packageId: string): Promise<void> {
    await this.ensureRunning(packageId);
    this.cancelRetry(packageId);
  }

  async stop(packageId: string): Promise<void> {
    this.cancelRetry(packageId);
    const existing = this.stopping.get(packageId);
    if (existing) return existing;
    const stopped = (async () => {
      this.bindings.hideArmoryPackage(packageId);
      const pending = this.starting.get(packageId);
      if (pending) await pending.catch(() => undefined);
      await Promise.allSettled([...(this.activeCalls.get(packageId) ?? [])]);
      const current = this.running.get(packageId);
      this.running.delete(packageId);
      if (current) await current.client.close().catch(() => current.transport.close().catch(() => undefined));
    })();
    this.stopping.set(packageId, stopped);
    try {
      await stopped;
    } finally {
      this.activeCalls.delete(packageId);
      if (this.stopping.get(packageId) === stopped) this.stopping.delete(packageId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.retryTimers.keys()) this.cancelRetry(id);
    await Promise.all([...new Set([...this.running.keys(), ...this.starting.keys()])].map((id) => this.stop(id)));
  }

  async listTools(packageId: string): Promise<Tool[]> {
    const current = await this.ensureRunning(packageId);
    return structuredClone(current.tools);
  }

  async describe(packageId: string): Promise<{ capable: boolean; enabled: boolean; running: boolean; endpoint: string | null; tools: Tool[] }> {
    const loaded = await this.loadPackage(packageId, false);
    const installed = await this.stores.installed.get(packageId);
    const current = this.running.get(packageId);
    return {
      capable: Boolean(loaded.manifest.mcp),
      enabled: Boolean(installed?.enabled),
      running: Boolean(current),
      endpoint: loaded.manifest.mcp ? `/mcp/armory/${packageId}` : null,
      tools: current ? structuredClone(current.tools) : [],
    };
  }

  async callTool(packageId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const current = await this.ensureRunning(packageId);
    if (this.stopping.has(packageId)) return toolError(`Armory package ${packageId} is stopping`);
    if (!current.tools.some((tool) => tool.name === name)) {
      return toolError(`Armory package ${packageId} does not expose tool: ${name}`);
    }
    try {
      const call = current.client.callTool(
        { name, arguments: args },
        undefined,
        {
          signal,
          timeout: Math.min(current.manifest.mcp?.callTimeoutMs ?? MAX_TOOL_CALL_MS, MAX_TOOL_CALL_MS),
          maxTotalTimeout: Math.min(current.manifest.mcp?.callTimeoutMs ?? MAX_TOOL_CALL_MS, MAX_TOOL_CALL_MS),
        },
      );
      const active = this.activeCalls.get(packageId) ?? new Set<Promise<unknown>>();
      active.add(call);
      this.activeCalls.set(packageId, active);
      let result;
      try { result = await call; }
      finally {
        active.delete(call);
        if (active.size === 0) this.activeCalls.delete(packageId);
      }
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) {
        return toolError(`Armory package ${packageId} returned a result larger than ${MAX_MCP_RESULT_BYTES} bytes`);
      }
      return result as CallToolResult;
    } catch (error) {
      return toolError(`Armory package ${packageId} tool call failed: ${safeMessage(error)}`);
    }
  }

  private async ensureRunning(packageId: string): Promise<RunningPackage> {
    if (this.closed) throw new ArmoryOperationError("MCP_DRAINING", "Armory MCP runtime is closed");
    if (this.stopping.has(packageId)) throw new ArmoryOperationError("MCP_DRAINING", `Armory package MCP is stopping: ${packageId}`);
    const existing = this.running.get(packageId);
    if (existing) return existing;
    const pending = this.starting.get(packageId);
    if (pending) return pending;
    const started = (async () => {
      const loaded = await this.loadPackage(packageId, true);
      const current = await this.connectPackage(loaded.manifest, loaded.packageDir);
      this.running.set(packageId, current);
      this.bindings.exposeArmoryPackage(packageId);
      current.transport.onclose = () => {
        if (this.running.get(packageId) !== current) return;
        this.running.delete(packageId);
        this.bindings.hideArmoryPackage(packageId);
        if (!this.closed && !this.stopping.has(packageId)) {
          void this.recoverUnexpectedClose(packageId);
        }
      };
      return current;
    })();
    this.starting.set(packageId, started);
    try {
      return await started;
    } finally {
      this.starting.delete(packageId);
    }
  }

  private async refreshTools(packageId: string): Promise<void> {
    const current = this.running.get(packageId);
    if (!current) throw new ArmoryOperationError("MCP_NOT_RUNNING", `Armory package MCP is not running: ${packageId}`);
    current.tools = (await current.client.listTools(undefined, {
      timeout: Math.min(current.manifest.mcp?.startupTimeoutMs ?? MAX_MCP_STARTUP_MS, MAX_MCP_STARTUP_MS),
    })).tools;
  }

  private async connectPackage(manifest: ArmoryManifest, packageDir: string): Promise<RunningPackage> {
    if (!manifest.mcp) throw new ArmoryOperationError("MCP_NOT_SUPPORTED", `Armory package does not provide MCP: ${manifest.id}`);
    const mcp = manifest.mcp;
    const command = await resolveMcpCommand(mcp.command, packageDir);
    const home = resolveContainedPath(this.stores.paths.homesDir, manifest.id);
    const providerEnvironment = Object.fromEntries(
      Object.entries(manifest.configuration?.environment ?? {}).map(([name, relative]) => [name, resolveContainedPath(home, relative)]),
    );
    const configuredValues = await this.stores.credentials.values(manifest.id);
    const sensitiveValues = manifest.configuration?.fields
      .filter((field) => field.type === "secret" || field.type === "file")
      .map((field) => configuredValues?.[field.id])
      .filter((value): value is string => value !== undefined) ?? [];
    const redactor = createArmoryRedactor(sensitiveValues);
    const transport = new StdioClientTransport({
      command: command.executable,
      args: command.args,
      cwd: packageDir,
      stderr: "pipe",
      env: {
        PATH: ARMORY_COMMAND_PATH,
        HOME: home,
        PEON_ARMORY_PACKAGE_DIR: packageDir,
        PEON_ARMORY_HOME: home,
        ...providerEnvironment,
      },
    });
    // Always drain stderr so a noisy package cannot block on a full pipe. Retain
    // only a bounded tail during startup, then discard it after a successful
    // connection so long-running provider output is never kept in memory.
    let stderrTail: Buffer = Buffer.alloc(0);
    let retainStderr = true;
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      if (!retainStderr) return;
      stderrTail = appendBoundedTail(stderrTail, chunk, MAX_MCP_STARTUP_STDERR_BYTES);
    });
    const client = new Client({ name: "peon-armory", version: "1.0.0" });
    const timeout = Math.min(mcp.startupTimeoutMs ?? MAX_MCP_STARTUP_MS, MAX_MCP_STARTUP_MS);
    try {
      await client.connect(transport, { timeout, maxTotalTimeout: timeout });
      const tools = (await client.listTools(undefined, { timeout, maxTotalTimeout: timeout })).tools;
      retainStderr = false;
      stderrTail = Buffer.alloc(0);
      return { client, transport, manifest, tools };
    } catch (error) {
      await client.close().catch(() => transport.close().catch(() => undefined));
      retainStderr = false;
      const safeStderr = redactor.text(stderrTail.toString("utf8")).trim();
      stderrTail = Buffer.alloc(0);
      const stderrDetail = safeStderr ? `\nStartup stderr:\n${safeStderr}` : "";
      throw new ArmoryOperationError(
        "MCP_START_FAILED",
        `Armory package ${manifest.id} MCP failed to start: ${safeMessage(error).slice(0, 500)}${stderrDetail}`,
        { cause: error },
      );
    }
  }

  private scheduleRetry(packageId: string): void {
    if (this.closed || this.retryTimers.has(packageId)) return;
    const attempt = this.retryAttempts.get(packageId) ?? 0;
    const delay = Math.min(this.retryInitialMs * (2 ** Math.min(attempt, 30)), this.retryMaxMs);
    this.retryAttempts.set(packageId, attempt + 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(packageId);
      void this.retryPackage(packageId).catch((error) => {
        this.reportBackgroundError(packageId, error);
        this.scheduleRetry(packageId);
      });
    }, delay);
    timer.unref?.();
    this.retryTimers.set(packageId, timer);
  }

  private cancelRetry(packageId: string): void {
    const timer = this.retryTimers.get(packageId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(packageId);
    this.retryAttempts.delete(packageId);
  }

  private async retryPackage(packageId: string): Promise<void> {
    if (this.closed) return;
    let installed;
    try {
      installed = await this.stores.installed.get(packageId);
    } catch (error) {
      this.reportBackgroundError(packageId, error);
      this.scheduleRetry(packageId);
      return;
    }
    if (!installed?.enabled) {
      this.cancelRetry(packageId);
      return;
    }
    try {
      await this.start(packageId);
    } catch (error) {
      await this.markUnavailable(packageId, error).catch((storeError) => this.reportBackgroundError(packageId, storeError));
      if (isRetryableStartupError(error)) this.scheduleRetry(packageId);
      return;
    }
    await this.markAvailable(packageId).catch((error) => this.reportBackgroundError(packageId, error));
  }

  private async recoverUnexpectedClose(packageId: string): Promise<void> {
    const installed = await this.stores.installed.get(packageId).catch((error) => {
      this.reportBackgroundError(packageId, error);
      return null;
    });
    if (!installed?.enabled || this.closed || this.stopping.has(packageId) || this.running.has(packageId)) return;
    const error = new ArmoryOperationError("MCP_START_FAILED", `Armory package ${packageId} MCP exited unexpectedly`);
    await this.markUnavailable(packageId, error).catch((storeError) => this.reportBackgroundError(packageId, storeError));
    if (this.running.has(packageId)) {
      await this.markAvailable(packageId).catch((storeError) => this.reportBackgroundError(packageId, storeError));
      return;
    }
    this.scheduleRetry(packageId);
  }

  private async markAvailable(packageId: string): Promise<void> {
    if (!this.running.has(packageId)) return;
    await this.stores.installed.update(packageId, (record) => record.enabled
      ? { ...record, state: "ready", lastError: null, updatedAt: Date.now() }
      : record);
  }

  private async markUnavailable(packageId: string, error: unknown): Promise<void> {
    this.bindings.hideArmoryPackage(packageId);
    await this.stores.installed.update(packageId, (record) => ({
      ...record,
      // `enabled` is desired operator state. A runtime failure must not turn it
      // into a durable disable operation.
      state: "error",
      lastError: safeMessage(error),
      updatedAt: Date.now(),
    }));
  }

  private reportBackgroundError(packageId: string, error: unknown): void {
    console.error(`Armory package ${packageId} MCP recovery failed: ${safeMessage(error)}`);
  }

  private async loadPackage(packageId: string, requireEnabled: boolean): Promise<{ manifest: ArmoryManifest; packageDir: string }> {
    const [activation, installed] = await Promise.all([
      getArmoryActivation(this.stores, packageId),
      this.stores.installed.get(packageId),
    ]);
    if (!activation || !installed) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
    if (requireEnabled && !installed.enabled) throw new ArmoryOperationError("PACKAGE_DISABLED", `Armory package is disabled: ${packageId}`);
    const packageDir = packageVersionPath(this.stores.paths, packageId, activation.version);
    try {
      const manifest = parseArmoryManifest(JSON.parse(await readFile(resolveContainedPath(packageDir, "armory.package.json"), "utf8")));
      return { manifest, packageDir };
    } catch (error) {
      throw new ArmoryOperationError("MANIFEST_INVALID", `Armory package manifest is invalid: ${packageId}`, { cause: error });
    }
  }
}

/** Performs durable enable/disable transitions around the MCP runtime. */
export class ArmoryMcpLifecycleService {
  readonly operations: ArmoryOperationCoordinator;

  constructor(private readonly runtime: ArmoryMcpRuntime) {
    this.operations = new ArmoryOperationCoordinator(runtime.stores.operations);
  }

  async enable(packageId: string) {
    return this.operations.start(packageId, "enable", async (operation) => {
      const current = await this.runtime.stores.installed.get(packageId);
      if (!current) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
      if (current.state !== "ready") throw new ArmoryOperationError("PACKAGE_NOT_READY", `Armory package is not ready: ${packageId}`);
      if (current.configurationStatus !== "not_required" && current.configurationStatus !== "verified") {
        throw new ArmoryOperationError("CONFIGURATION_NOT_VERIFIED", `Armory package configuration is not verified: ${packageId}`);
      }
      if (current.capabilities?.mcp === false || (current.capabilities === undefined && !(await this.runtime.describe(packageId)).capable)) {
        throw new ArmoryOperationError("MCP_NOT_SUPPORTED", `Armory package does not provide MCP: ${packageId}`);
      }
      if (current.enabled) {
        await operation.update("starting", 75, "Ensuring package MCP server is running");
        await this.runtime.start(packageId);
        return;
      }
      await operation.update("health_check", 30, "Checking package MCP server");
      await this.runtime.healthCheck(packageId);
      await this.runtime.stores.installed.set({ ...current, enabled: true, activeOperationId: operation.operationId, lastError: null, updatedAt: Date.now() });
      try {
        await operation.update("starting", 75, "Starting package MCP server");
        await this.runtime.start(packageId);
        await this.runtime.stores.installed.update(packageId, (record) => ({ ...record, activeOperationId: null, updatedAt: Date.now() }));
      } catch (error) {
        await this.runtime.stores.installed.set({ ...current, enabled: false, activeOperationId: null, state: "error", lastError: safeMessage(error), updatedAt: Date.now() });
        throw error;
      }
    });
  }

  async disable(packageId: string) {
    return this.operations.start(packageId, "disable", async (operation) => {
      const current = await this.runtime.stores.installed.get(packageId);
      if (!current) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
      await operation.update("stopping", 50, "Stopping package MCP server");
      await this.runtime.stop(packageId);
      await this.runtime.stores.installed.set({ ...current, enabled: false, activeOperationId: null, updatedAt: Date.now() });
    });
  }
}

async function resolveMcpCommand(command: ArmoryCommand, packageDir: string): Promise<{ executable: string; args: string[] }> {
  if (command.executable === "node") {
    const script = command.args[0];
    if (!script || script.startsWith("-")) throw new ArmoryOperationError("MCP_COMMAND_INVALID", "Node MCP command must begin with a package-relative script");
    const scriptPath = resolveContainedPath(packageDir, script);
    const details = await lstat(scriptPath).catch(() => null);
    if (!details?.isFile()) throw new ArmoryOperationError("MCP_COMMAND_INVALID", "Node MCP script is not a regular package file");
    return { executable: process.execPath, args: [scriptPath, ...command.args.slice(1)] };
  }
  const executable = resolveContainedPath(packageDir, command.executable);
  const details = await lstat(executable).catch(() => null);
  if (!details?.isFile()) throw new ArmoryOperationError("MCP_COMMAND_INVALID", "MCP executable is not a regular package file");
  return { executable, args: command.args };
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function appendBoundedTail(current: Buffer, chunk: Buffer | string, maxBytes: number): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (incoming.byteLength >= maxBytes) return incoming.subarray(incoming.byteLength - maxBytes);
  const combined = Buffer.concat([current, incoming]);
  return combined.byteLength <= maxBytes ? combined : combined.subarray(combined.byteLength - maxBytes);
}

function isRetryableStartupError(error: unknown): boolean {
  return error instanceof ArmoryOperationError && error.code === "MCP_START_FAILED";
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
