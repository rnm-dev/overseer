import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";
import type { ArmoryInventoryReader } from "./inventory.js";
import type { ArmoryMcpRuntime } from "./mcpRuntime.js";
import { ArmoryOperationCoordinator, ArmoryOperationError } from "./operationCoordinator.js";
import type { ArmoryProjectPackagesService } from "./projectPackages.js";
import type { ArmoryStores } from "./stores.js";

export const ARMORY_PACKAGE_OPERATIONS_CAPABILITY = "armory-package-operations-v1";

export interface ArmoryCheck {
  id: string;
  status: "pass" | "fail";
  code: string | null;
}

export class ArmoryRuntimeOperationsService {
  readonly operations: ArmoryOperationCoordinator;

  constructor(private readonly options: {
    stores: ArmoryStores;
    inventory: ArmoryInventoryReader;
    runtime: ArmoryMcpRuntime;
    projectPackages: ArmoryProjectPackagesService;
    peonVersion?: string;
  }) {
    this.operations = new ArmoryOperationCoordinator(options.stores.operations);
  }

  async preflight(packageId: string, version?: string): Promise<{ packageId: string; version: string | null; compatible: boolean; checks: ArmoryCheck[] }> {
    const detail = await this.options.inventory.get(packageId);
    const selected = detail.catalog?.versions.find((entry) => entry.version === (version ?? detail.catalog?.latest));
    const checks: ArmoryCheck[] = [];
    if (!detail.catalog) checks.push({ id: "catalog", status: "fail", code: "PACKAGE_NOT_AVAILABLE" });
    else checks.push({ id: "catalog", status: "pass", code: null });
    if (detail.catalog && !selected) checks.push({ id: "version", status: "fail", code: "VERSION_NOT_FOUND" });
    else if (selected) checks.push({ id: "version", status: "pass", code: null });
    if (selected) {
      const platform = `${process.platform}/${process.arch}`;
      const supported = selected.platforms.some((entry) => `${entry.os}/${entry.arch}` === platform);
      checks.push({ id: "platform", status: supported ? "pass" : "fail", code: supported ? null : "UNSUPPORTED_PLATFORM" });
      const compatible = semver.gte(this.options.peonVersion ?? packageVersion(), selected.minPeonVersion);
      checks.push({ id: "peon-version", status: compatible ? "pass" : "fail", code: compatible ? null : "INCOMPATIBLE_PEON_VERSION" });
      checks.push({ id: "archive-size", status: "pass", code: null });
    }
    return { packageId, version: selected?.version ?? null, compatible: checks.length > 0 && checks.every((entry) => entry.status === "pass"), checks };
  }

  usage(packageId: string) {
    return this.options.runtime.usage(packageId);
  }

  drainStatus(packageId: string) {
    return this.options.runtime.drainStatus(packageId);
  }

  async diagnose(packageId: string, projectId?: string) {
    if (!await this.options.stores.installed.get(packageId)) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
    if (projectId) await this.options.projectPackages.getAssignment(projectId, packageId);
    const checks = await this.options.runtime.diagnose(packageId, projectId);
    return { packageId, projectId: projectId ?? null, healthy: checks.every((entry) => entry.status === "pass"), checks, checkedAt: Date.now() };
  }

  async restart(packageId: string) {
    if (!await this.options.stores.installed.get(packageId)) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
    return this.operations.start(packageId, "restart", async (operation) => {
      await operation.update("draining", 25, "Waiting for active package turns to finish");
      await this.options.runtime.restart(packageId);
      await operation.update("verified", 90, "Package runtime restarted and verified");
    });
  }

  async reload(projectId: string, packageId: string) {
    await this.options.projectPackages.getAssignment(projectId, packageId);
    return this.operations.start(packageId, "reload", async (operation) => {
      await operation.update("draining", 25, "Waiting for active package turns to finish");
      await this.options.runtime.restart(packageId);
      await operation.update("reloaded", 90, "Project package selection will reload on its next turn");
    });
  }

  async drain(packageId: string) {
    if (!await this.options.stores.installed.get(packageId)) throw new ArmoryOperationError("PACKAGE_NOT_ACTIVE", `Armory package is not installed: ${packageId}`);
    return this.operations.start(packageId, "drain", async (operation) => {
      await operation.update("draining", 25, "Waiting for active package turns to finish");
      await this.options.runtime.stop(packageId);
      await operation.update("drained", 90, "Package runtime drained");
    });
  }
}

function packageVersion(): string {
  try {
    const file = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const value = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
    return typeof value === "string" && semver.valid(value) ? value : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
