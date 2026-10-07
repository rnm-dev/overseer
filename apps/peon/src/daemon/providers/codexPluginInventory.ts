import os from "node:os";
import path from "node:path";
import { CodexAppServerRuntime } from "../agents/runtimes/codexAppServerRuntime.js";

type PluginRuntime = Pick<CodexAppServerRuntime, "start" | "request" | "stop">;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

// CLI plugin list also consults remote marketplaces. A Stats refresh should use
// Codex's cached inventory, not wait for remote marketplace synchronization.
export async function codexInstalledPlugins(command: string, runtime: PluginRuntime = new CodexAppServerRuntime({
  command, experimentalApi: true, requestTimeoutMs: 8_000, maxRestartAttempts: 1,
})): Promise<Record<string, unknown>[]> {
  try {
    await runtime.start();
    const payload = object(await runtime.request("plugin/list", { forceRefetch: false }));
    if (!Array.isArray(payload?.marketplaces)) throw new Error("Codex returned invalid plugin inventory");
    return payload.marketplaces.flatMap((raw) => {
      const marketplace = object(raw);
      if (!Array.isArray(marketplace?.plugins)) return [];
      return marketplace.plugins.flatMap((rawPlugin): Record<string, unknown>[] => {
        const plugin = object(rawPlugin);
        if (!plugin || plugin.installed !== true) return [];
        const version = plugin.localVersion ?? plugin.version;
        const segments = [marketplace.name, plugin.name, version];
        const source = object(plugin.source);
        const cachePath = segments.every((part) => typeof part === "string" && part !== "." && part !== ".." && !/[\\/]/.test(part))
          ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", ...segments as string[])
          : null;
        return [{ ...plugin, pluginId: plugin.id, marketplaceName: marketplace.name, version,
          source: { ...source, path: typeof source?.path === "string" ? source.path : cachePath },
        }];
      });
    });
  } finally { await runtime.stop(); }
}
