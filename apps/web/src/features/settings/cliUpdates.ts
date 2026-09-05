export type CliProvider = "codex" | "claude-code";

export interface CliUpdateItem {
  provider: CliProvider;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  installationKind: string | null;
  updateSupported: boolean | null;
  updateReason: string | null;
  checkedAt: number | null;
  status: string;
  error: string | null;
}

const providers: CliProvider[] = ["codex", "claude-code"];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(...values: unknown[]): string | null {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return typeof value === "string" ? value : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function providerOf(value: unknown): CliProvider | null {
  if (value === "codex") return "codex";
  if (value === "claude-code" || value === "claudeCode" || value === "claude") return "claude-code";
  return null;
}

function entries(raw: unknown): Array<[CliProvider | null, Record<string, unknown>]> {
  if (Array.isArray(raw)) return raw.flatMap((value) => object(value) ? [[null, object(value)!] as const] : []);
  const root = object(raw);
  if (!root) return [];
  for (const key of ["tools", "providers", "updates", "items", "agents"]) {
    const nested = root[key];
    if (Array.isArray(nested)) return entries(nested);
    const map = object(nested);
    if (map) {
      const mapped = providers.flatMap((provider) => {
        const value = provider === "claude-code" ? map[provider] ?? map.claudeCode ?? map.claude : map[provider];
        return object(value) ? [[provider, object(value)!] as [CliProvider, Record<string, unknown>]] : [];
      });
      if (mapped.length) return mapped;
    }
  }
  const keyed = providers.flatMap((provider) => {
    const value = provider === "claude-code" ? root[provider] ?? root.claudeCode ?? root.claude : root[provider];
    return object(value) ? [[provider, object(value)!] as [CliProvider, Record<string, unknown>]] : [];
  });
  if (keyed.length) return keyed;
  return [[null, root]];
}

export function normalizeCliUpdates(raw: unknown): CliUpdateItem[] {
  const result = new Map<CliProvider, CliUpdateItem>();
  for (const [hint, value] of entries(raw)) {
    const provider = hint ?? providerOf(value.provider ?? value.id ?? value.agent ?? value.tool ?? value.name);
    if (!provider) continue;
    const operation = object(value.operation ?? value.update ?? value.action);
    const currentVersion = text(value.currentVersion, value.installedVersion, value.current, value.version);
    const latestVersion = text(value.latestVersion, value.availableVersion, value.latest);
    const status = text(operation?.status, operation?.state, value.updateStatus, value.status) ?? "idle";
    const failed = ["failed", "failure"].includes(status.toLowerCase());
    result.set(provider, {
      provider,
      currentVersion,
      latestVersion,
      updateAvailable: typeof value.updateAvailable === "boolean"
        ? value.updateAvailable
        : value.updateAvailable === null
          ? null
        : currentVersion && latestVersion ? currentVersion !== latestVersion : null,
      installationKind: text(value.installationKind),
      updateSupported: typeof value.updateSupported === "boolean" ? value.updateSupported : null,
      updateReason: text(value.updateReason),
      checkedAt: timestamp(value.checkedAt ?? value.lastCheckedAt ?? value.refreshedAt),
      status,
      error: text(operation?.error, value.updateReason, value.updateError, value.checkError, value.error, failed ? operation?.message : null),
    });
  }
  return providers.flatMap((provider) => result.has(provider) ? [result.get(provider)!] : []);
}

export function cliUpdateBusy(status: string): boolean {
  return ["queued", "running", "installing", "updating", "starting"].includes(status.toLowerCase());
}
