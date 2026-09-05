import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ModelInfo, ReasoningEffort, ReasoningEffortInfo } from "./registry.js";

export interface AgentModelCatalogService {
  discover(command: string): Promise<ModelInfo[]>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function effortLabel(id: string): string {
  return id === "xhigh" ? "Extra high" : id[0]?.toUpperCase() + id.slice(1);
}

function effortList(values: unknown, defaultEffort?: unknown): ReasoningEffortInfo[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const raw = typeof value === "string" ? value
      : value && typeof value === "object" ? (value as Record<string, unknown>).reasoningEffort : null;
    const id = text(raw);
    if (!id || id.length > 80 || seen.has(id)) return [];
    seen.add(id);
    return [{ id: id as ReasoningEffort, label: effortLabel(id), ...(id === defaultEffort ? { default: true as const } : {}) }];
  });
}

export function normalizeCodexModelResponse(raw: unknown): ModelInfo[] {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const rows = Array.isArray(root?.data) ? root.data : [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let hasDefault = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    if (value.hidden === true) continue;
    const id = text(value.model) ?? text(value.id);
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const catalogId = text(value.id);
    const selectedDefault: boolean = value.isDefault === true && !hasDefault;
    if (selectedDefault) hasDefault = true;
    models.push({
      id,
      label: text(value.displayName) ?? id,
      ...(catalogId && catalogId !== id ? { alias: catalogId } : {}),
      ...(selectedDefault ? { default: true as const } : {}),
      reasoningEfforts: effortList(value.supportedReasoningEfforts, value.defaultReasoningEffort),
    });
  }
  if (models.length && !hasDefault) models[0] = { ...models[0], default: true };
  return models;
}

export function normalizeClaudeModelResponse(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const rows = raw.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  const defaultRow = rows.find((row) => row.value === "default");
  const defaultId = text(defaultRow?.resolvedModel) ?? null;
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    const cliValue = text(value.value);
    if (!cliValue || cliValue === "default") continue;
    const id = text(value.resolvedModel) ?? cliValue;
    if (id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: text(value.displayName) ?? id,
      ...(cliValue !== id ? { alias: cliValue } : {}),
      ...(id === defaultId ? { default: true as const } : {}),
      reasoningEfforts: value.supportsEffort === false ? [] : effortList(value.supportedEffortLevels),
    });
  }
  if (defaultId && !seen.has(defaultId)) {
    models.unshift({
      id: defaultId,
      label: text(defaultRow?.displayName) ?? defaultId,
      default: true,
      reasoningEfforts: defaultRow?.supportsEffort === false ? [] : effortList(defaultRow?.supportedEffortLevels),
    });
  }
  if (models.length && !models.some((model) => model.default)) models[0] = { ...models[0], default: true };
  return models;
}

interface CodexModelCatalogRuntime {
  start(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export function createCodexModelCatalogService(
  runtimeFor: (command: string) => CodexModelCatalogRuntime,
): AgentModelCatalogService {
  return {
    async discover(command) {
      const runtime = runtimeFor(command);
      await runtime.start();
      const rows: unknown[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const response = await runtime.request<Record<string, unknown>>("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        if (Array.isArray(response.data)) rows.push(...response.data);
        cursor = text(response.nextCursor);
        if (!cursor) break;
      }
      const models = normalizeCodexModelResponse({ data: rows });
      if (!models.length) throw new Error("Codex app-server returned an empty model catalog");
      return models;
    },
  };
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 1_000);
  force.unref?.();
  child.once("exit", () => clearTimeout(force));
}

async function claudeInitialize(command: string): Promise<unknown[]> {
  const requestId = `peon-models-${randomUUID()}`;
  const child = spawn(command, [
    "-p", "--safe-mode", "--no-session-persistence", "--tools", "",
    "--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
  });
  return new Promise<unknown[]>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (error: Error | null, models?: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild(child);
      if (error) reject(error); else resolve(models ?? []);
    };
    const timer = setTimeout(() => finish(new Error("Claude CLI model discovery timed out")), 15_000);
    timer.unref?.();
    child.once("error", (error) => finish(new Error(`Unable to start Claude CLI model discovery: ${error.message}`)));
    child.once("spawn", () => {
      child.stdin.write(`${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "initialize" },
      })}\n`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_096);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 8 * 1024 * 1024) return finish(new Error("Claude CLI model discovery response exceeded 8 MiB"));
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const response = message.response && typeof message.response === "object"
          ? message.response as Record<string, unknown> : null;
        if (message.type !== "control_response" || response?.request_id !== requestId) continue;
        if (response.subtype !== "success") {
          return finish(new Error(text(response.error) ?? "Claude CLI rejected model discovery"));
        }
        const body = response.response && typeof response.response === "object"
          ? response.response as Record<string, unknown> : null;
        return finish(null, Array.isArray(body?.models) ? body.models : []);
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Claude CLI model discovery exited (${signal ?? code ?? "unknown"}): ${stderr.trim() || "no error output"}`));
    });
  });
}

export const claudeModelCatalogService: AgentModelCatalogService = {
  async discover(command) {
    const models = normalizeClaudeModelResponse(await claudeInitialize(command));
    if (!models.length) throw new Error("Claude CLI returned an empty model catalog");
    return models;
  },
};
