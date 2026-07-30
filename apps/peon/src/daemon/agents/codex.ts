import { projectRelativePath } from "./toolPaths.js";

export const MAX_EDIT_DIFF_BYTES = 512 * 1024;
export const MAX_EDIT_DIFF_LINE_BYTES = 64 * 1024;

type FileChange = Record<string, unknown> & {
  path?: unknown;
  kind?: unknown;
  diff?: unknown;
  patch?: unknown;
};

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function boundedDiff(value: string, remainingBytes: number): {
  diff: string;
  bytes: number;
  truncated: boolean;
  originalBytes: number;
} {
  const originalBytes = Buffer.byteLength(value);
  let truncated = originalBytes > remainingBytes;
  let diff = utf8Prefix(value, remainingBytes);
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (Buffer.byteLength(lines[i]) <= MAX_EDIT_DIFF_LINE_BYTES) continue;
    lines[i] = utf8Prefix(lines[i], MAX_EDIT_DIFF_LINE_BYTES);
    truncated = true;
  }
  diff = lines.join("\n");
  return { diff, bytes: Buffer.byteLength(diff), truncated, originalBytes };
}

/** Normalize file-change items emitted by the Codex app-server runtime. */
export function normalizeCodexFileChanges(item: Record<string, unknown>, cwd?: string): Record<string, unknown>[] {
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  let remainingBytes = MAX_EDIT_DIFF_BYTES;
  return rawChanges.map((raw) => {
    const change: FileChange = raw && typeof raw === "object" ? raw as FileChange : {};
    const normalized: Record<string, unknown> = {
      ...change,
      path: projectRelativePath(change.path, cwd),
      ...(Object.hasOwn(change, "oldPath") ? { oldPath: projectRelativePath(change.oldPath, cwd) } : {}),
    };
    const runtimeDiff = typeof change.diff === "string"
      ? change.diff
      : typeof change.patch === "string"
        ? change.patch
        : rawChanges.length === 1 && typeof item.diff === "string"
          ? item.diff
          : rawChanges.length === 1 && typeof item.patch === "string"
            ? item.patch
            : undefined;
    delete normalized.patch;
    if (runtimeDiff === undefined) {
      normalized.diffUnavailable = "runtime_did_not_expose_patch";
      return normalized;
    }
    const bounded = boundedDiff(runtimeDiff, remainingBytes);
    normalized.diff = bounded.diff;
    remainingBytes -= bounded.bytes;
    if (bounded.truncated) {
      normalized.diffTruncated = true;
      normalized.diffOriginalBytes = bounded.originalBytes;
    }
    return normalized;
  });
}

// Codex reports all local shell work as command_execution. Give common
// read-only/development commands stable provider-neutral names.
export function codexCommandToolName(command: unknown): string {
  if (typeof command !== "string") return "Bash";
  let unwrapped = command.replace(/^\s*(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/, "").trim();
  if ((unwrapped.startsWith('"') && unwrapped.endsWith('"')) || (unwrapped.startsWith("'") && unwrapped.endsWith("'"))) {
    unwrapped = unwrapped.slice(1, -1).trim();
  }
  if (/\n|&&|\|\||;/.test(unwrapped)) return "Bash";
  if (/^(?:rg|grep|ag|ack)\b/.test(unwrapped)) return "Search";
  if (/^(?:ls|find|fd|tree)\b/.test(unwrapped)) return "List";
  if (/^(?:cat|sed|head|tail|less|bat)\b/.test(unwrapped)) return "Read";
  if (/^git\b/.test(unwrapped)) return "Git";
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check|typecheck)|pytest\b|cargo\s+test\b|go\s+test\b)/.test(unwrapped)) return "Test";
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)|tsc\b|cargo\s+build\b|go\s+build\b)/.test(unwrapped)) return "Build";
  return "Bash";
}
