import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "./settings/index.js";
import { QUOTA_PROVIDERS, type QuotaProvider } from "./providerQuota.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const COMMAND_TIMEOUT_MS = 8_000;

export interface CapabilityItem {
  id: string;
  name: string;
  enabled: boolean;
  source?: string;
  version?: string;
  transport?: string;
}

export interface ProviderCapabilitiesSnapshot {
  provider: string;
  status: "ok" | "error";
  updatedAt: number;
  plugins: CapabilityItem[];
  skills: CapabilityItem[];
  mcps: CapabilityItem[];
  error?: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function safeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, " ").slice(0, 300);
}

async function commandJson(command: string, args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  return JSON.parse(stdout);
}

function skillName(file: string): string {
  try {
    const head = readFileSync(file, "utf8").slice(0, 4096);
    const match = head.match(/^name:\s*["']?([^\r\n"']+)/m);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    // Fall back to the containing directory.
  }
  return path.basename(path.dirname(file));
}

function scanSkills(root: string, source: string, maxDepth = 6): CapabilityItem[] {
  if (!existsSync(root)) return [];
  const results: CapabilityItem[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "SKILL.md") {
        const name = skillName(full);
        results.push({ id: `${source}:${name}`, name, enabled: true, source });
      } else if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(full).isDirectory()) visit(full, depth + 1);
        } catch {
          // Ignore broken/inaccessible skill links.
        }
      }
    }
  };
  visit(root, 0);
  return results;
}

function dedupe(items: CapabilityItem[]): CapabilityItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.name}\0${item.source ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function readJsonFile(file: string): JsonObject | null {
  try {
    return object(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export async function fetchCodexCapabilities(): Promise<ProviderCapabilitiesSnapshot> {
  const command = settings.get().codexCommand || "codex";
  const errors: string[] = [];
  let plugins: CapabilityItem[] = [];
  let skills = scanSkills(path.join(os.homedir(), ".codex", "skills"), "user");
  let mcps: CapabilityItem[] = [];

  try {
    const payload = object(await commandJson(command, ["plugin", "list", "--json"]));
    const installed = Array.isArray(payload?.installed) ? payload.installed : [];
    plugins = installed.flatMap((raw): CapabilityItem[] => {
      const plugin = object(raw);
      if (!plugin) return [];
      const id = String(plugin.pluginId ?? plugin.name ?? "plugin");
      const name = String(plugin.name ?? id);
      const source = object(plugin.source);
      const sourcePath = typeof source?.path === "string" && path.isAbsolute(source.path) ? source.path : null;
      if (sourcePath) skills.push(...scanSkills(path.join(sourcePath, "skills"), `plugin:${name}`));
      return [{
        id,
        name,
        enabled: plugin.enabled !== false,
        ...(typeof plugin.marketplaceName === "string" ? { source: plugin.marketplaceName } : {}),
        ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
      }];
    });
  } catch (err) {
    errors.push(`plugins: ${safeError(err)}`);
  }

  try {
    const payload = await commandJson(command, ["mcp", "list", "--json"]);
    mcps = (Array.isArray(payload) ? payload : []).flatMap((raw): CapabilityItem[] => {
      const mcp = object(raw);
      if (!mcp || typeof mcp.name !== "string") return [];
      const transport = object(mcp.transport);
      return [{
        id: mcp.name,
        name: mcp.name,
        enabled: mcp.enabled !== false,
        ...(typeof transport?.type === "string" ? { transport: transport.type } : {}),
      }];
    });
  } catch (err) {
    errors.push(`mcps: ${safeError(err)}`);
  }

  return {
    provider: "codex",
    status: errors.length === 2 ? "error" : "ok",
    updatedAt: Date.now(),
    plugins: dedupe(plugins),
    skills: dedupe(skills),
    mcps: dedupe(mcps),
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

function claudeConfiguredMcps(pluginMcps: CapabilityItem[]): CapabilityItem[] {
  const results = [...pluginMcps];
  const files = [
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(process.cwd(), ".mcp.json"),
  ];
  for (const file of files) {
    const root = readJsonFile(file);
    const servers = object(root?.mcpServers);
    for (const [name, raw] of Object.entries(servers ?? {})) {
      const config = object(raw);
      const transport = typeof config?.type === "string"
        ? config.type
        : typeof config?.url === "string"
          ? "http"
          : "stdio";
      results.push({ id: `config:${name}`, name, enabled: true, source: path.basename(file), transport });
    }
  }
  return dedupe(results);
}

export async function fetchClaudeCapabilities(): Promise<ProviderCapabilitiesSnapshot> {
  const command = settings.get().agentCommand || "claude";
  const errors: string[] = [];
  let plugins: CapabilityItem[] = [];
  let skills = scanSkills(path.join(os.homedir(), ".claude", "skills"), "user");
  const pluginMcps: CapabilityItem[] = [];

  try {
    const payload = await commandJson(command, ["plugin", "list", "--json"]);
    plugins = (Array.isArray(payload) ? payload : []).flatMap((raw): CapabilityItem[] => {
      const plugin = object(raw);
      if (!plugin) return [];
      const id = String(plugin.id ?? "plugin");
      const name = id.split("@")[0] || id;
      if (typeof plugin.installPath === "string" && path.isAbsolute(plugin.installPath)) {
        skills.push(...scanSkills(path.join(plugin.installPath, "skills"), `plugin:${name}`));
      }
      const servers = object(plugin.mcpServers);
      for (const [serverName, serverRaw] of Object.entries(servers ?? {})) {
        const server = object(serverRaw);
        const transport = typeof server?.type === "string"
          ? server.type
          : typeof server?.url === "string"
            ? "http"
            : "stdio";
        pluginMcps.push({ id: `plugin:${id}:${serverName}`, name: serverName, enabled: plugin.enabled !== false, source: `plugin:${name}`, transport });
      }
      return [{
        id,
        name,
        enabled: plugin.enabled !== false,
        ...(typeof plugin.scope === "string" ? { source: plugin.scope } : {}),
        ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
      }];
    });
  } catch (err) {
    errors.push(`plugins: ${safeError(err)}`);
  }

  return {
    provider: "claude-code",
    status: errors.length ? "error" : "ok",
    updatedAt: Date.now(),
    plugins: dedupe(plugins),
    skills: dedupe(skills),
    mcps: claudeConfiguredMcps(pluginMcps),
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

const cache = new Map<QuotaProvider, ProviderCapabilitiesSnapshot>();
const inFlight = new Map<QuotaProvider, Promise<ProviderCapabilitiesSnapshot>>();

async function getProvider(provider: QuotaProvider, force = false): Promise<ProviderCapabilitiesSnapshot> {
  const current = cache.get(provider);
  if (!force && current && Date.now() - current.updatedAt < CACHE_MS) return current;
  const running = inFlight.get(provider);
  if (running) return running;
  const fetcher: Record<string, () => Promise<ProviderCapabilitiesSnapshot>> = {
    "claude-code": fetchClaudeCapabilities,
    codex: fetchCodexCapabilities,
  };
  const selected = fetcher[provider];
  const request = (selected ? selected() : Promise.resolve({ provider, status: "error" as const, updatedAt: Date.now(), plugins: [], skills: [], mcps: [], error: `No capability service registered for ${provider}` }))
    .then((snapshot) => {
      cache.set(provider, snapshot);
      return snapshot;
    })
    .finally(() => { inFlight.delete(provider); });
  inFlight.set(provider, request);
  return request;
}

export const getClaudeCapabilities = (force = false) => getProvider("claude-code", force);
export const getCodexCapabilities = (force = false) => getProvider("codex", force);

export const providerCapabilities = {
  getProvider,
  async get(force = false): Promise<{ updatedAt: number; providers: ProviderCapabilitiesSnapshot[] }> {
    const providers = await Promise.all(QUOTA_PROVIDERS.map((provider) => getProvider(provider, force)));
    return { updatedAt: Math.max(...providers.map((provider) => provider.updatedAt)), providers };
  },
};
