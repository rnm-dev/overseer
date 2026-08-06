import path from "node:path";
import { configDir, dataDir, stateDir } from "../xdgPaths.js";

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ArmoryPaths {
  dataRoot: string;
  packagesDir: string;
  activeDir: string;
  homesDir: string;
  stagingDir: string;
  stateRoot: string;
  installedFile: string;
  operationsDir: string;
  logsDir: string;
  ownershipFile: string;
  catalogCacheFile: string;
  settingsFile: string;
  credentialsFile: string;
  projectPackagesFile: string;
}

export interface ArmoryPathRoots {
  data: string;
  state: string;
  config: string;
}

export function createArmoryPaths(roots: ArmoryPathRoots = { data: dataDir(), state: stateDir(), config: configDir() }): ArmoryPaths {
  const dataRoot = path.join(roots.data, "armory");
  const stateRoot = path.join(roots.state, "armory");
  return {
    dataRoot,
    packagesDir: path.join(dataRoot, "packages"),
    activeDir: path.join(dataRoot, "active"),
    homesDir: path.join(dataRoot, "homes"),
    stagingDir: path.join(dataRoot, "staging"),
    stateRoot,
    installedFile: path.join(stateRoot, "installed.json"),
    operationsDir: path.join(stateRoot, "operations"),
    logsDir: path.join(stateRoot, "logs"),
    ownershipFile: path.join(stateRoot, "ownership.json"),
    catalogCacheFile: path.join(stateRoot, "catalog-cache.json"),
    settingsFile: path.join(roots.config, "armory-settings.json"),
    credentialsFile: path.join(roots.config, "armory-credentials.json"),
    projectPackagesFile: path.join(roots.config, "armory-project-packages.json"),
  };
}

export function assertPackageId(value: string): string {
  if (!PACKAGE_ID.test(value)) throw new ArmoryPathError("INVALID_PACKAGE_ID", `Invalid Armory package id: ${value}`);
  return value;
}

export function resolveContainedPath(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ArmoryPathError("PATH_OUTSIDE_ARMORY_ROOT", `Path escapes Armory root: ${candidate}`);
  }
  return candidate;
}

export function packageLogPath(paths: ArmoryPaths, packageId: string): string {
  return resolveContainedPath(paths.logsDir, `${assertPackageId(packageId)}.log`);
}

export function packageVersionPath(paths: ArmoryPaths, packageId: string, version: string): string {
  return resolveContainedPath(paths.packagesDir, assertPackageId(packageId), version);
}

export function packageActivationPath(paths: ArmoryPaths, packageId: string): string {
  return resolveContainedPath(paths.activeDir, `${assertPackageId(packageId)}.json`);
}

export class ArmoryPathError extends Error {
  constructor(readonly code: "INVALID_PACKAGE_ID" | "PATH_OUTSIDE_ARMORY_ROOT", message: string) {
    super(message);
    this.name = "ArmoryPathError";
  }
}
