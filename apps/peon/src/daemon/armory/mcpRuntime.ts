import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  armoryActivationSchema,
  armoryProjectPackagesStateSchema,
  installedStateSchema,
  MAX_MCP_RESULT_BYTES,
  MAX_MCP_STARTUP_MS,
  MAX_TOOL_CALL_MS,
  parseArmoryManifest,
  type ArmoryCommand,
  type ArmoryManifest,
  type StoredArmoryProfile,
} from "./contracts.js";
import { ArmoryHookRunner } from "./hookRunner.js";
import { ArmoryOperationError, ArmoryOperationCoordinator } from "./operationCoordinator.js";
import { packageActivationPath, packageVersionPath, resolveContainedPath } from "./paths.js";
import type { ArmoryPackageRuntimeController } from "./configuration.js";
import { createArmoryRedactor } from "./redaction.js";
import { ARMORY_COMMAND_PATH } from "./runtimeEnvironment.js";
import type { ArmoryStores } from "./stores.js";
import {
  mcpBindingRegistry,
  type ArmoryTurnBindingLease,
  type ArmoryTurnContext,
  type ArmoryTurnUnavailable,
  type McpBindingRegistry,
} from "../mcpBindings.js";

interface ArmoryRuntimeSelection {
  runtimeKey: string;
  packageId: string;
  artifactDigest: string;
  packageDir: string;
  manifest: ArmoryManifest;
  profileId: string | null;
  profileUpdatedAt: number | null;
  profileValues: Record<string, string>;
  workflowExecution: { executionId: string; leaseToken: string } | null;
}

interface RunningPackage {
  client: Client;
  transport: StdioClientTransport;
  selection: ArmoryRuntimeSelection;
  tools: Tool[];
}

interface TurnBinding {
  sessionId: string;
  turnId: string;
  selection: ArmoryRuntimeSelection;
}

const MAX_MCP_STARTUP_STDERR_BYTES = 16 * 1024;
const DEFAULT_MCP_DRAIN_TIMEOUT_MS = 30_000;

/** Owns assignment-scoped MCP children acquired by immutable provider-turn leases. */
export class ArmoryMcpRuntime implements ArmoryPackageRuntimeController {
  private readonly running = new Map<string, RunningPackage>();
  private readonly starting = new Map<string, Promise<RunningPackage>>();
  private readonly activeCalls = new Map<string, Set<Promise<unknown>>>();
  private readonly bindingsById = new Map<string, TurnBinding>();
  private readonly selectionsByKey = new Map<string, ArmoryRuntimeSelection>();
  private readonly leaseCounts = new Map<string, number>();
  private readonly draining = new Map<string, Promise<void>>();
  private readonly drainResolvers = new Map<string, () => void>();
  private readonly hookRunner = new ArmoryHookRunner();
  private readonly drainTimeoutMs: number;
  private closed = false;

  constructor(
    readonly stores: ArmoryStores,
    private readonly bindings: McpBindingRegistry = mcpBindingRegistry,
    options: { drainTimeoutMs?: number } = {},
  ) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_MCP_DRAIN_TIMEOUT_MS;
    this.bindings.registerArmoryProvider(this);
  }

  snapshotTurn(context: ArmoryTurnContext): ArmoryTurnBindingLease {
    if (this.closed) throw new ArmoryOperationError("MCP_DRAINING", "Armory MCP runtime is closed");
    const { selections, unavailable } = this.resolveTurnSelections(context.projectId, context.workflowExecution);
    for (const issue of unavailable) {
      console.warn(`Armory package unavailable for session ${context.sessionId}: ${issue.packageId ?? "assignment store"} (${issue.code})`);
    }
    const bindingIds: string[] = [];
    for (const selection of selections) {
      const bindingId = randomUUID();
      this.selectionsByKey.set(selection.runtimeKey, selection);
      this.bindingsById.set(bindingId, { sessionId: context.sessionId, turnId: context.turnId, selection });
      this.leaseCounts.set(selection.runtimeKey, (this.leaseCounts.get(selection.runtimeKey) ?? 0) + 1);
      bindingIds.push(bindingId);
    }
    let released = false;
    return {
      bindings: selections.map((selection, index) => ({ packageId: selection.packageId, bindingId: bindingIds[index]! })),
      ...(unavailable.length > 0 ? { unavailable } : {}),
      release: () => {
        if (released) return;
        released = true;
        for (const bindingId of bindingIds) this.releaseBinding(bindingId);
      },
    };
  }

  async reconcile(): Promise<void> {
    // Assignment-scoped providers are started lazily by a turn and carry no
    // daemon-wide desired state. A restart therefore has nothing to auto-start.
    await Promise.all([...this.running.keys()].filter((key) => (this.leaseCounts.get(key) ?? 0) === 0).map((key) => this.drainRuntime(key)));
  }

  async healthCheck(packageId: string): Promise<void> {
    const loaded = await this.loadInstalledPackage(packageId);
    if (!loaded.manifest.mcp) return;
    if (loaded.manifest.profile) {
      throw new ArmoryOperationError("PROFILE_REQUIRED", `Armory package requires an assigned profile: ${packageId}`);
    }
    const selection = this.selection(loaded.manifest, loaded.packageDir, loaded.artifactDigest, null);
    const temporary = await this.connectPackage(selection);
    await temporary.client.close().catch(() => temporary.transport.close().catch(() => undefined));
  }

  async start(_packageId: string): Promise<void> {
    // Packages have no global running state. A validated turn lease starts the
    // exact artifact/profile selection lazily on its first MCP request.
  }

  async stop(packageId: string): Promise<void> {
    const keys = new Set<string>();
    for (const [key, selection] of this.selectionsByKey) if (selection.packageId === packageId) keys.add(key);
    for (const [key, current] of this.running) if (current.selection.packageId === packageId) keys.add(key);
    for (const [key, pending] of this.starting) {
      void pending;
      if (runtimeKeyPackageId(key) === packageId) keys.add(key);
    }
    if (keys.size === 0) return;
    const activeLeases = [...keys].reduce((count, key) => count + (this.leaseCounts.get(key) ?? 0), 0);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([...keys].map((key) => this.drainRuntime(key))),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ArmoryOperationError(
            "MCP_DRAIN_TIMEOUT",
            `Timed out after ${this.drainTimeoutMs}ms waiting for ${activeLeases} active turn lease(s) across ${keys.size} runtime(s) to release for package ${packageId}. The update cannot stop the previous package safely. Finish or cancel sessions using this package, then retry the update.`,
            { details: { packageId, activeLeases, runtimes: keys.size, timeoutMs: this.drainTimeoutMs } },
          )), this.drainTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.bindingsById.clear();
    this.leaseCounts.clear();
    await Promise.all([...new Set([...this.running.keys(), ...this.starting.keys()])].map((key) => this.forceCloseRuntime(key)));
  }

  async listTools(bindingId: string, sessionId: string): Promise<Tool[]> {
    const current = await this.ensureRunning(this.requireBinding(bindingId, sessionId).selection);
    return structuredClone(current.tools);
  }

  async describe(packageId: string): Promise<{ capable: boolean; running: boolean; endpoint: null; tools: Tool[] }> {
    const loaded = await this.loadInstalledPackage(packageId);
    const current = [...this.running.values()].filter((entry) => entry.selection.packageId === packageId);
    return {
      capable: Boolean(loaded.manifest.mcp),
      running: current.length > 0,
      endpoint: null,
      tools: current.length === 1 ? structuredClone(current[0]!.tools) : [],
    };
  }

  async callTool(bindingId: string, sessionId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const binding = this.requireBinding(bindingId, sessionId);
    const current = await this.ensureRunning(binding.selection);
    if (!current.tools.some((tool) => tool.name === name)) return toolError(`Armory package ${binding.selection.packageId} does not expose tool: ${name}`);
    try {
      const call = current.client.callTool(
        { name, arguments: args },
        undefined,
        {
          signal,
          timeout: Math.min(current.selection.manifest.mcp?.callTimeoutMs ?? MAX_TOOL_CALL_MS, MAX_TOOL_CALL_MS),
          maxTotalTimeout: Math.min(current.selection.manifest.mcp?.callTimeoutMs ?? MAX_TOOL_CALL_MS, MAX_TOOL_CALL_MS),
        },
      );
      const active = this.activeCalls.get(current.selection.runtimeKey) ?? new Set<Promise<unknown>>();
      active.add(call);
      this.activeCalls.set(current.selection.runtimeKey, active);
      let result;
      try { result = await call; }
      finally {
        active.delete(call);
        if (active.size === 0) this.activeCalls.delete(current.selection.runtimeKey);
      }
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) {
        return toolError(`Armory package ${binding.selection.packageId} returned a result larger than ${MAX_MCP_RESULT_BYTES} bytes`);
      }
      return result as CallToolResult;
    } catch (error) {
      return toolError(`Armory package ${binding.selection.packageId} tool call failed: ${safeMessage(error)}`);
    }
  }

  private requireBinding(bindingId: string, sessionId: string): TurnBinding {
    const binding = this.bindingsById.get(bindingId);
    if (!binding || binding.sessionId !== sessionId) throw new ArmoryOperationError("MCP_BINDING_INVALID", "Armory MCP binding is unavailable for this turn");
    return binding;
  }

  private releaseBinding(bindingId: string): void {
    const binding = this.bindingsById.get(bindingId);
    if (!binding) return;
    this.bindingsById.delete(bindingId);
    const key = binding.selection.runtimeKey;
    const remaining = Math.max(0, (this.leaseCounts.get(key) ?? 1) - 1);
    if (remaining === 0) {
      this.leaseCounts.delete(key);
      const resumeDrain = this.drainResolvers.get(key);
      if (resumeDrain) resumeDrain();
      else void this.drainRuntime(key).catch((error) => console.error(`Armory runtime drain failed: ${safeMessage(error)}`));
    } else {
      this.leaseCounts.set(key, remaining);
    }
  }

  private async ensureRunning(selection: ArmoryRuntimeSelection): Promise<RunningPackage> {
    if (this.closed) throw new ArmoryOperationError("MCP_DRAINING", "Armory MCP runtime is closed");
    const existing = this.running.get(selection.runtimeKey);
    if (existing) return existing;
    const pending = this.starting.get(selection.runtimeKey);
    if (pending) return pending;
    const started = (async () => {
      const current = await this.connectPackage(selection);
      this.running.set(selection.runtimeKey, current);
      current.transport.onclose = () => {
        if (this.running.get(selection.runtimeKey) === current) this.running.delete(selection.runtimeKey);
      };
      return current;
    })();
    this.starting.set(selection.runtimeKey, started);
    try { return await started; }
    finally { this.starting.delete(selection.runtimeKey); }
  }

  private async drainRuntime(runtimeKey: string): Promise<void> {
    const existing = this.draining.get(runtimeKey);
    if (existing) return existing;
    const drained = new Promise<void>((resolve, reject) => {
      const attempt = () => {
        if ((this.leaseCounts.get(runtimeKey) ?? 0) > 0) {
          this.drainResolvers.set(runtimeKey, attempt);
          return;
        }
        this.drainResolvers.delete(runtimeKey);
        void this.forceCloseRuntime(runtimeKey).then(resolve, reject);
      };
      attempt();
    });
    this.draining.set(runtimeKey, drained);
    try { await drained; }
    finally { if (this.draining.get(runtimeKey) === drained) this.draining.delete(runtimeKey); }
  }

  private async forceCloseRuntime(runtimeKey: string): Promise<void> {
    const pending = this.starting.get(runtimeKey);
    if (pending) await pending.catch(() => undefined);
    await Promise.allSettled([...(this.activeCalls.get(runtimeKey) ?? [])]);
    this.activeCalls.delete(runtimeKey);
    const current = this.running.get(runtimeKey);
    this.running.delete(runtimeKey);
    if (current) await current.client.close().catch(() => current.transport.close().catch(() => undefined));
    const selection = current?.selection ?? this.selectionsByKey.get(runtimeKey);
    if (selection) {
      const homeKey = createHash("sha256").update(selection.runtimeKey).digest("hex");
      await rm(resolveContainedPath(this.stores.paths.homesDir, "runtime", homeKey), { recursive: true, force: true });
    }
    if ((this.leaseCounts.get(runtimeKey) ?? 0) === 0) this.selectionsByKey.delete(runtimeKey);
  }

  private resolveTurnSelections(projectId: string, workflow?: ArmoryTurnContext["workflowExecution"]): { selections: ArmoryRuntimeSelection[]; unavailable: ArmoryTurnUnavailable[] } {
    try {
      const projectPackages = armoryProjectPackagesStateSchema.parse(JSON.parse(readFileSync(this.stores.paths.projectPackagesFile, "utf8")));
      if (projectPackages.migrationCompletedAt === null) throw new Error("migration incomplete");
      const installed = installedStateSchema.parse(JSON.parse(readFileSync(this.stores.paths.installedFile, "utf8")));
      const assignments = projectPackages.assignments
        .filter((assignment) => assignment.projectId === projectId)
        .sort((left, right) => left.packageId.localeCompare(right.packageId));
      const selections: ArmoryRuntimeSelection[] = [];
      const unavailable: ArmoryTurnUnavailable[] = [];
      for (const assignment of assignments) {
        try {
          const record = installed.packages[assignment.packageId];
          if (!record) throw new ArmoryOperationError("PACKAGE_NOT_INSTALLED", `Assigned Armory package is not installed: ${assignment.packageId}`);
          if (record.state !== "ready" || record.activeOperationId !== null) {
            throw new ArmoryOperationError("PACKAGE_NOT_READY", `Assigned Armory package is not ready: ${assignment.packageId}`);
          }
          const activation = armoryActivationSchema.parse(JSON.parse(readFileSync(packageActivationPath(this.stores.paths, assignment.packageId), "utf8")));
          if (activation.version !== record.version || activation.sourceDigest !== record.sourceDigest) {
            throw new ArmoryOperationError("PACKAGE_NOT_READY", `Assigned Armory package activation is inconsistent: ${assignment.packageId}`);
          }
          const packageDir = packageVersionPath(this.stores.paths, assignment.packageId, activation.version);
          const manifest = parseArmoryManifest(JSON.parse(readFileSync(resolveContainedPath(packageDir, "armory.package.json"), "utf8")));
          if (manifest.id !== assignment.packageId || manifest.version !== activation.version) {
            throw new ArmoryOperationError("PACKAGE_NOT_READY", `Assigned Armory package manifest does not match its artifact: ${assignment.packageId}`);
          }
          const profile = assignment.profileId === null ? null : projectPackages.profiles[assignment.profileId];
          this.validateAssignment(manifest, assignment.profileId, profile);
          if (manifest.mcp) selections.push(this.selection(
            manifest,
            packageDir,
            activation.sourceDigest,
            profile,
            workflow?.packageId === manifest.id ? { executionId: workflow.executionId, leaseToken: workflow.leaseToken } : null,
          ));
        } catch (error) {
          unavailable.push({
            packageId: assignment.packageId,
            code: error instanceof ArmoryOperationError ? error.code : "PACKAGE_RESOLUTION_FAILED",
            message: error instanceof ArmoryOperationError
              ? error.message
              : `Assigned Armory package could not be resolved: ${assignment.packageId}`,
          });
        }
      }
      return { selections, unavailable };
    } catch (error) {
      return {
        selections: [],
        unavailable: [{
          packageId: null,
          code: error instanceof ArmoryOperationError ? error.code : "ARMORY_ASSIGNMENT_RESOLUTION_FAILED",
          message: "Armory project assignments could not be resolved safely; Armory tools are unavailable for this turn.",
        }],
      };
    }
  }

  private validateAssignment(manifest: ArmoryManifest, profileId: string | null, profile: StoredArmoryProfile | null | undefined): void {
    if (!manifest.profile) {
      if (profileId !== null) throw new ArmoryOperationError("PROFILE_TYPE_MISMATCH", `Credential-free Armory package ${manifest.id} requires profileId null`);
      return;
    }
    if (!profileId || !profile) throw new ArmoryOperationError("PROFILE_NOT_FOUND", `Assigned Armory profile is missing for package ${manifest.id}`);
    if (profile.type !== manifest.profile.type) throw new ArmoryOperationError("PROFILE_TYPE_MISMATCH", `Assigned Armory profile type does not match package ${manifest.id}`);
    const missing = manifest.profile.requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(profile.values, field) || profile.values[field]?.length === 0);
    if (missing.length > 0) throw new ArmoryOperationError("PROFILE_FIELDS_MISSING", `Assigned Armory profile is missing required fields for package ${manifest.id}`);
    if (profile.status !== "verified") throw new ArmoryOperationError("PROFILE_NOT_VERIFIED", `Assigned Armory profile is not verified for package ${manifest.id}`);
  }

  private selection(manifest: ArmoryManifest, packageDir: string, artifactDigest: string, profile: StoredArmoryProfile | null, workflowExecution: ArmoryRuntimeSelection["workflowExecution"] = null): ArmoryRuntimeSelection {
    const consumedFields = new Set(manifest.configuration?.fields.map((field) => field.id) ?? []);
    const profileValues = Object.fromEntries(Object.entries(profile?.values ?? {}).filter(([fieldId]) => consumedFields.has(fieldId)));
    const stateDigest = createHash("sha256").update(JSON.stringify(Object.entries(profileValues).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
    const runtimeKey = [manifest.id, artifactDigest, profile?.profileId ?? "credential-free", profile?.updatedAt ?? 0, stateDigest, workflowExecution?.executionId ?? "interactive"].join(":");
    return {
      runtimeKey,
      packageId: manifest.id,
      artifactDigest,
      packageDir,
      manifest,
      profileId: profile?.profileId ?? null,
      profileUpdatedAt: profile?.updatedAt ?? null,
      profileValues,
      workflowExecution,
    };
  }

  private async loadInstalledPackage(packageId: string): Promise<{ manifest: ArmoryManifest; packageDir: string; artifactDigest: string }> {
    const installed = await this.stores.installed.get(packageId);
    if (!installed) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
    const activation = armoryActivationSchema.parse(JSON.parse(await readFile(packageActivationPath(this.stores.paths, packageId), "utf8")));
    const packageDir = packageVersionPath(this.stores.paths, packageId, activation.version);
    try {
      const manifest = parseArmoryManifest(JSON.parse(await readFile(resolveContainedPath(packageDir, "armory.package.json"), "utf8")));
      return { manifest, packageDir, artifactDigest: activation.sourceDigest };
    } catch (error) {
      throw new ArmoryOperationError("MANIFEST_INVALID", `Armory package manifest is invalid: ${packageId}`, { cause: error });
    }
  }

  private async connectPackage(selection: ArmoryRuntimeSelection): Promise<RunningPackage> {
    const { manifest, packageDir } = selection;
    if (!manifest.mcp) throw new ArmoryOperationError("MCP_NOT_SUPPORTED", `Armory package does not provide MCP: ${manifest.id}`);
    const mcp = manifest.mcp;
    const command = await resolveMcpCommand(mcp.command, packageDir);
    const homeKey = createHash("sha256").update(selection.runtimeKey).digest("hex");
    const home = resolveContainedPath(this.stores.paths.homesDir, "runtime", homeKey);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const providerEnvironment = Object.fromEntries(
      Object.entries(manifest.configuration?.environment ?? {}).map(([name, relative]) => [name, resolveContainedPath(home, relative)]),
    );
    const sensitiveValues = Object.values(selection.profileValues);
    const redactor = createArmoryRedactor(sensitiveValues);
    if (manifest.configuration && selection.profileId !== null) {
      const baseInput = {
        protocolVersion: 1 as const,
        type: "input" as const,
        package: { id: manifest.id, version: manifest.version, dir: packageDir, home },
        platform: currentPlatform(),
      };
      await this.hookRunner.run({
        command: manifest.configuration.handler,
        input: { ...baseInput, operation: "configure", configuration: structuredClone(selection.profileValues) },
        packageDir,
        managedHome: home,
        environment: providerEnvironment,
        sensitiveValues,
        validateOwnedPaths: (owned) => validateRuntimeOwnedPaths(owned, manifest, home),
      });
      if (manifest.configuration.verifyHandler) {
        await this.hookRunner.run({
          command: manifest.configuration.verifyHandler,
          input: { ...baseInput, operation: "verify" },
          packageDir,
          managedHome: home,
          environment: providerEnvironment,
          sensitiveValues,
        });
      }
    }
    const transport = new StdioClientTransport({
      command: command.executable,
      args: command.args,
      cwd: packageDir,
      stderr: "pipe",
      env: {
        PATH: ARMORY_COMMAND_PATH,
        HOME: home,
        // Armory packages run with an isolated HOME, but declared host paths
        // such as ~/Projects must still resolve against the operator's home.
        PEON_ARMORY_HOST_HOME: os.homedir(),
        PEON_ARMORY_PACKAGE_DIR: packageDir,
        PEON_ARMORY_HOME: home,
        ...(selection.workflowExecution ? {
          PEON_WORKFLOW_EXECUTION: selection.workflowExecution.executionId,
          PEON_WORKFLOW_LEASE: selection.workflowExecution.leaseToken,
        } : {}),
        ...providerEnvironment,
      },
    });
    let stderrTail: Buffer = Buffer.alloc(0);
    let retainStderr = true;
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      if (retainStderr) stderrTail = appendBoundedTail(stderrTail, chunk, MAX_MCP_STARTUP_STDERR_BYTES);
    });
    const client = new Client({ name: "peon-armory", version: "1.0.0" });
    const timeout = Math.min(mcp.startupTimeoutMs ?? MAX_MCP_STARTUP_MS, MAX_MCP_STARTUP_MS);
    try {
      await client.connect(transport, { timeout, maxTotalTimeout: timeout });
      const tools = (await client.listTools(undefined, { timeout, maxTotalTimeout: timeout })).tools;
      retainStderr = false;
      stderrTail = Buffer.alloc(0);
      return { client, transport, selection, tools };
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
}

/** Retained only for pre-capability API compatibility; capable APIs return 410 first. */
export class ArmoryMcpLifecycleService {
  readonly operations: ArmoryOperationCoordinator;
  constructor(private readonly runtime: ArmoryMcpRuntime) {
    this.operations = new ArmoryOperationCoordinator(runtime.stores.operations);
  }
  async enable(packageId: string) {
    return this.operations.start(packageId, "enable", async () => {
      throw new ArmoryOperationError("ARMORY_ACTIVATION_RETIRED", "Package enablement is replaced by project assignments");
    });
  }
  async disable(packageId: string) {
    return this.operations.start(packageId, "disable", async () => {
      throw new ArmoryOperationError("ARMORY_ACTIVATION_RETIRED", "Package enablement is replaced by project assignments");
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

function validateRuntimeOwnedPaths(owned: string[], manifest: ArmoryManifest, home: string): void {
  const managed = new Set(manifest.configuration?.managedPaths ?? []);
  const hostHome = os.homedir();
  const hostRoots = manifest.permissions.hostPaths.filter((entry) => entry.mode === "write").map((entry) => path.resolve(entry.path.replace(/^~\//, `${hostHome}/`)));
  for (const value of owned) {
    if (!path.isAbsolute(value) && !value.startsWith("~/")) {
      if (!managed.has(value) || resolveContainedPath(home, value) === home) throw new ArmoryOperationError("OWNED_PATH_UNDECLARED", "Package configuration reported an undeclared runtime path");
      continue;
    }
    const absolute = path.resolve(value.replace(/^~\//, `${hostHome}/`));
    if (!hostRoots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))) {
      throw new ArmoryOperationError("OWNED_PATH_UNDECLARED", "Package configuration reported an undeclared host path");
    }
  }
}

function currentPlatform(): { os: "darwin" | "linux"; arch: "x64" | "arm64" } {
  if ((process.platform !== "darwin" && process.platform !== "linux") || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new ArmoryOperationError("UNSUPPORTED_PLATFORM", `Armory does not support ${process.platform}/${process.arch}`);
  }
  return { os: process.platform, arch: process.arch };
}

function runtimeKeyPackageId(runtimeKey: string): string { return runtimeKey.split(":", 1)[0] ?? ""; }
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
function appendBoundedTail(current: Buffer, chunk: Buffer | string, maxBytes: number): Buffer {
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (incoming.byteLength >= maxBytes) return incoming.subarray(incoming.byteLength - maxBytes);
  const combined = Buffer.concat([current, incoming]);
  return combined.byteLength <= maxBytes ? combined : combined.subarray(combined.byteLength - maxBytes);
}
function toolError(message: string): CallToolResult { return { isError: true, content: [{ type: "text", text: message }] }; }
