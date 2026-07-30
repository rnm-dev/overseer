import path from "node:path";
export function globalInstallPrefix(packageRoot) {
    const resolved = path.resolve(packageRoot);
    let candidate = resolved;
    for (;;) {
        if (path.basename(candidate) === "node_modules") {
            const relative = path.relative(candidate, resolved);
            const parts = relative.split(path.sep).filter(Boolean);
            const packageShape = parts.length === 1
                || (parts.length === 2 && parts[0]?.startsWith("@"));
            if (!packageShape)
                break;
            const libDir = path.dirname(candidate);
            if (path.basename(libDir) !== "lib")
                break;
            return path.dirname(libDir);
        }
        const parent = path.dirname(candidate);
        if (parent === candidate)
            break;
        candidate = parent;
    }
    throw new Error(`cannot derive the global npm prefix from package root: ${resolved}`);
}
export function globalInstallArgs(packageRoot, spec) {
    return ["install", "-g", "--prefix", globalInstallPrefix(packageRoot), spec];
}
export function rollbackPackArgs(packageRoot, destination) {
    return ["pack", "--ignore-scripts", "--json", "--pack-destination", destination, packageRoot];
}
