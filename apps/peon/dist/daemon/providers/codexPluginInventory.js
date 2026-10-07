import os from "node:os";
import path from "node:path";
import { CodexAppServerRuntime } from "../agents/index.js";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
// CLI plugin list also consults remote marketplaces. A Stats refresh should use
// Codex's cached inventory, not wait for remote marketplace synchronization.
export async function codexInstalledPlugins(command, runtime = new CodexAppServerRuntime({
    command, experimentalApi: true, requestTimeoutMs: 8_000, maxRestartAttempts: 1,
})) {
    try {
        await runtime.start();
        const payload = object(await runtime.request("plugin/list", { forceRefetch: false }));
        if (!Array.isArray(payload?.marketplaces))
            throw new Error("Codex returned invalid plugin inventory");
        return payload.marketplaces.flatMap((raw) => {
            const marketplace = object(raw);
            if (!Array.isArray(marketplace?.plugins))
                return [];
            return marketplace.plugins.flatMap((rawPlugin) => {
                const plugin = object(rawPlugin);
                if (!plugin || plugin.installed !== true)
                    return [];
                const version = plugin.localVersion ?? plugin.version;
                const segments = [marketplace.name, plugin.name, version];
                const source = object(plugin.source);
                const cachePath = segments.every((part) => typeof part === "string" && part !== "." && part !== ".." && !/[\\/]/.test(part))
                    ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", ...segments)
                    : null;
                return [{ ...plugin, pluginId: plugin.id, marketplaceName: marketplace.name, version,
                        source: { ...source, path: typeof source?.path === "string" ? source.path : cachePath },
                    }];
            });
        });
    }
    finally {
        await runtime.stop();
    }
}
