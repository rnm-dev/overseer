import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
async function run(command, args, timeout = 30_000) {
    const result = await execFileAsync(command, args, { timeout, maxBuffer: 1024 * 1024, env: process.env });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}
async function resolveExecutable(command) {
    const candidates = command.includes("/") || command.includes("\\")
        ? [path.resolve(command)]
        : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
    for (const executable of candidates) {
        try {
            await access(executable, constants.X_OK);
            return { executable, realExecutable: await realpath(executable) };
        }
        catch {
            // Keep looking along PATH. The version check will report a missing command
            // only after all candidates have been exhausted.
        }
    }
    throw new Error(`configured CLI command is not executable: ${command}`);
}
async function executableMagic(realExecutable) {
    const handle = await open(realExecutable, "r");
    try {
        const bytes = Buffer.alloc(4);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        return bytes.subarray(0, bytesRead).toString("hex");
    }
    finally {
        await handle.close();
    }
}
export const agentCliUpdateRuntime = {
    resolve: resolveExecutable,
    magic: executableMagic,
    run,
};
function slash(value) {
    return value.replaceAll("\\", "/").toLowerCase();
}
function packagePath(packageName) {
    return `/node_modules/${packageName.toLowerCase()}/`;
}
function isNativeExecutableMagic(magic) {
    return magic.startsWith("7f454c46") // ELF
        || magic.startsWith("4d5a") // PE/COFF
        || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "cafebabf"].includes(magic);
}
export function classifyAgentCliInstallation(input) {
    const executable = slash(input.realExecutable);
    const externallyManaged = [
        "/nix/store/", "/.asdf/", "/.volta/", "/.local/share/mise/", "/mise/installs/",
        "/devbox/", "/pnpm/", "/.pnpm/", "/.yarn/", "/yarn/global/", "/.bun/",
    ];
    if (externallyManaged.some((fragment) => executable.includes(fragment))) {
        return {
            installationKind: "externally-managed",
            updateSupported: false,
            reason: "CLI is owned by an external version manager; update it with that manager",
        };
    }
    if (executable.includes(packagePath(input.packageName)) && executable.includes("/lib/node_modules/")) {
        return { installationKind: "npm", updateSupported: true, reason: null };
    }
    if (executable.includes(packagePath(input.packageName))) {
        return {
            installationKind: "externally-managed",
            updateSupported: false,
            reason: "CLI is inside a non-global node_modules tree; update it with the package manager that owns that tree",
        };
    }
    if (executable.includes("/cellar/") || executable.includes("/caskroom/")) {
        return { installationKind: "homebrew", updateSupported: true, reason: null };
    }
    if ((input.nativePathFragments ?? []).some((fragment) => executable.includes(slash(fragment)))) {
        return { installationKind: "native", updateSupported: true, reason: null };
    }
    if (isNativeExecutableMagic(input.magic)) {
        return { installationKind: "standalone", updateSupported: true, reason: null };
    }
    return {
        installationKind: "unknown",
        updateSupported: false,
        reason: "CLI executable is a wrapper or has an unknown owner; automatic update was refused",
    };
}
export function createSelfUpdatingCliUpdater(options) {
    return {
        async inspect(command, runtime = agentCliUpdateRuntime) {
            const resolved = await runtime.resolve(command);
            const classified = classifyAgentCliInstallation({
                realExecutable: resolved.realExecutable,
                magic: await runtime.magic(resolved.realExecutable),
                packageName: options.packageName,
                nativePathFragments: options.nativePathFragments,
            });
            if (classified.updateSupported) {
                const versionOutput = await runtime.run(resolved.executable, ["--version"]);
                const identityPattern = new RegExp(options.versionPattern.source, options.versionPattern.flags.replace(/[gy]/g, ""));
                if (!identityPattern.test(versionOutput)) {
                    return {
                        ...resolved,
                        installationKind: "unknown",
                        updateSupported: false,
                        reason: "resolved executable does not identify itself as the expected provider CLI",
                    };
                }
            }
            return { ...resolved, ...classified };
        },
        async latestVersion(_inspection, runtime = agentCliUpdateRuntime) {
            return runtime.run("npm", ["view", options.packageName, "version", "--json"]);
        },
        async apply(inspection, runtime = agentCliUpdateRuntime) {
            if (!inspection.updateSupported)
                throw new Error(inspection.reason ?? "automatic CLI update is not supported");
            await runtime.run(inspection.executable, ["update"], 30 * 60_000);
        },
        verify(inspection, runtime = agentCliUpdateRuntime) {
            return runtime.run(inspection.executable, ["--version"]);
        },
    };
}
