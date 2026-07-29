import path from "node:path";
import { configDir, dataDir, stateDir } from "../xdgPaths.js";
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function createArmoryPaths(roots = { data: dataDir(), state: stateDir(), config: configDir() }) {
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
    };
}
export function assertPackageId(value) {
    if (!PACKAGE_ID.test(value))
        throw new ArmoryPathError("INVALID_PACKAGE_ID", `Invalid Armory package id: ${value}`);
    return value;
}
export function resolveContainedPath(root, ...segments) {
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(resolvedRoot, ...segments);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new ArmoryPathError("PATH_OUTSIDE_ARMORY_ROOT", `Path escapes Armory root: ${candidate}`);
    }
    return candidate;
}
export function packageLogPath(paths, packageId) {
    return resolveContainedPath(paths.logsDir, `${assertPackageId(packageId)}.log`);
}
export function packageVersionPath(paths, packageId, version) {
    return resolveContainedPath(paths.packagesDir, assertPackageId(packageId), version);
}
export function packageActivationPath(paths, packageId) {
    return resolveContainedPath(paths.activeDir, `${assertPackageId(packageId)}.json`);
}
export class ArmoryPathError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ArmoryPathError";
    }
}
